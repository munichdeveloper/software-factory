import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
import tarfile
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import client
from protocol import admit, evaluate

if 'fcntl' not in sys.modules:
    try: import fcntl
    except ImportError: sys.modules['fcntl'] = types.SimpleNamespace(LOCK_EX=1, LOCK_NB=2, flock=lambda *args: None)
import backup_command as server

NOW = datetime(2026, 11, 9, tzinfo=timezone.utc)
TEST_TEMP = Path(__file__).resolve().parents[2] / '.runtime' / 'ops-tests'
TEST_TEMP.mkdir(parents=True, exist_ok=True)
HEALTHY = {'ok': True, 'services': {n: {'status': 'running', 'health': 'healthy'} for n in ('postgres', 'temporal', 'worker', 'ui')},
           'temporal': {'ok': True, 'metrics': {}}}


class CommandTests(unittest.TestCase):
    def test_exact_commands_only(self):
        self.assertEqual(admit('status'), ('status', None))
        self.assertEqual(admit('snapshot'), ('snapshot', None))
        self.assertEqual(admit('fetch 20261109T000000Z-1234abcd'), ('fetch', '20261109T000000Z-1234abcd'))

    def test_shell_and_traversal_are_rejected(self):
        for command in ['', 'bash', 'status;cat /etc/shadow', 'snapshot --recipient attacker',
                        'fetch ../../.env', 'fetch 20261109T000000Z-1234abcd\n', ' fetch 20261109T000000Z-1234abcd',
                        'fetch 20261109T000000Z-1234abcd;id', 'scp -f /etc/shadow', 'sftp', 'status\x00']:
            with self.subTest(command=command), self.assertRaises(ValueError): admit(command)


class AlertTests(unittest.TestCase):
    def test_healthy_and_fresh_backup(self):
        self.assertEqual(evaluate(HEALTHY, (NOW - timedelta(hours=20)).isoformat(), NOW), [])

    def test_stale_missing_and_future_backup(self):
        self.assertIn('OFFSITE_BACKUP_MISSING', evaluate(HEALTHY, None, NOW))
        self.assertIn('OFFSITE_BACKUP_OLDER_THAN_24_HOURS', evaluate(HEALTHY, (NOW - timedelta(hours=25)).isoformat(), NOW))
        self.assertIn('BACKUP_CLOCK_INVALID', evaluate(HEALTHY, (NOW + timedelta(hours=1)).isoformat(), NOW))

    def test_temporal_and_worker_failures(self):
        status = copy.deepcopy(HEALTHY); status['temporal']['ok'] = False; status['services']['worker']['status'] = 'exited'
        alerts = evaluate(status, NOW.isoformat(), NOW)
        self.assertIn('TEMPORAL_UNAVAILABLE', alerts); self.assertIn('SERVICE_UNAVAILABLE:worker', alerts)

    def test_missing_service_is_not_healthy(self):
        status = copy.deepcopy(HEALTHY); del status['services']['postgres']
        self.assertIn('SERVICE_UNAVAILABLE:postgres', evaluate(status, NOW.isoformat(), NOW))

    def test_queue_retry_timeout_thresholds(self):
        status = copy.deepcopy(HEALTHY); status['temporal']['metrics'] = {'maximumPendingTaskAgeSeconds': 301, 'maximumActivityAttempt': 3, 'recentTimedOutWorkflows': 1}
        alerts = evaluate(status, NOW.isoformat(), NOW)
        self.assertEqual(set(alerts), {'QUEUE_WAIT_OVER_5_MINUTES', 'ACTIVITY_RETRY_OVER_BUDGET', 'WORKFLOW_TIMEOUT'})

    def test_dedup_and_recovery(self):
        state = {}; first = client.incidents(state, ['TEMPORAL_UNAVAILABLE'], NOW.isoformat())
        second = client.incidents(state, ['TEMPORAL_UNAVAILABLE'], (NOW + timedelta(minutes=30)).isoformat())
        self.assertEqual(first[0]['deliveryId'], second[0]['deliveryId'])
        state['deliveries'][first[0]['deliveryId']]['status'] = 'sent'
        recovered = client.incidents(state, [], (NOW + timedelta(hours=1)).isoformat())
        self.assertEqual(len(recovered), 1); self.assertEqual(recovered[0]['kind'], 'recovery')
        self.assertEqual(client.incidents(state, [], (NOW + timedelta(hours=2)).isoformat()), recovered)

    def test_obsolete_unsent_incident_is_cancelled(self):
        state = {}; client.incidents(state, ['TEMPORAL_UNAVAILABLE'], NOW.isoformat())
        self.assertEqual(client.incidents(state, [], NOW.isoformat()), [])

    def test_ambiguous_delivery_waits_for_reconciliation(self):
        state = {}; first = client.incidents(state, ['TEMPORAL_UNAVAILABLE'], NOW.isoformat())
        state['deliveries'][first[0]['deliveryId']]['status'] = 'unknown'
        unresolved = client.incidents(state, [], NOW.isoformat())
        self.assertEqual(unresolved[0]['status'], 'unknown'); self.assertEqual(len(unresolved), 1)
        state['deliveries'][first[0]['deliveryId']]['status'] = 'sent'
        self.assertEqual(client.incidents(state, [], NOW.isoformat())[0]['kind'], 'recovery')


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=TEST_TEMP); self.addCleanup(self.directory.cleanup)
        self.body = b'age-encryption.org/v1\nsynthetic encrypted fixture'
        self.config = {'backupDirectory': self.directory.name, 'recipient': 'age1fixture', 'knownHosts': 'known', 'privateKey': 'key', 'user': 'root', 'host': '187.126.26.9'}
        self.manifest = {'snapshotId': '20261109T000000Z-1234abcd', 'sha256': hashlib.sha256(self.body).hexdigest(),
                         'bytes': len(self.body), 'recipient': 'age1fixture', 'format': 'age', 'sourceServicesResumed': True,
                         'createdAt': datetime.now(timezone.utc).isoformat()}

    def fake_ssh(self, args, **kwargs):
        self.assertEqual(args[-1], 'fetch ' + self.manifest['snapshotId'])
        kwargs['stdout'].write(self.body)
        return types.SimpleNamespace(returncode=0)

    def test_atomic_verified_download_and_reuse(self):
        with patch.object(client.subprocess, 'run', side_effect=self.fake_ssh) as ssh:
            result = client.download(self.config, self.manifest)
            self.assertTrue(result.exists()); self.assertEqual(result.read_bytes(), self.body)
            self.assertEqual(client.download(self.config, self.manifest), result)
            self.assertEqual(ssh.call_count, 1)
        self.assertFalse(list(Path(self.directory.name).glob('*.part')))

    def test_corrupted_transfer_not_promoted(self):
        self.manifest['sha256'] = 'a' * 64
        with patch.object(client.subprocess, 'run', side_effect=self.fake_ssh), self.assertRaises(ValueError):
            client.download(self.config, self.manifest)
        self.assertFalse(list(Path(self.directory.name).iterdir()))

    def test_unsafe_manifest_never_calls_ssh(self):
        for field, bad in [('snapshotId', '../../secret'), ('bytes', -1), ('recipient', 'age1attacker'), ('sourceServicesResumed', False)]:
            manifest = {**self.manifest, field: bad}
            with patch.object(client.subprocess, 'run') as ssh, self.assertRaises(ValueError): client.download(self.config, manifest)
            ssh.assert_not_called()

    def test_existing_wrong_file_is_never_replaced(self):
        path = Path(self.directory.name) / (self.manifest['snapshotId'] + '.tar.gz.age'); path.write_bytes(b'previous file')
        with patch.object(client.subprocess, 'run') as ssh, self.assertRaises(ValueError): client.download(self.config, self.manifest)
        ssh.assert_not_called(); self.assertEqual(path.read_bytes(), b'previous file')

    def test_disabled_runner_has_no_remote_side_effect(self):
        with patch.object(client, 'remote_json') as remote:
            result = client.collect({'enabled': False}, {}, True)
        remote.assert_not_called(); self.assertEqual(result['activation'], 'pending_approval')

    def test_lost_snapshot_receipt_reuses_remote_manifest(self):
        status = copy.deepcopy(HEALTHY); status['latestSnapshot'] = self.manifest
        with patch.object(client, 'remote_json', return_value=status) as remote, patch.object(client, 'download') as download, patch.object(client, 'ui_check', return_value=True):
            state = {}; result = client.collect(self.config | {'enabled': True, 'channelId': 'C0A5XUJFZPF'}, state)
        remote.assert_called_once_with(self.config | {'enabled': True, 'channelId': 'C0A5XUJFZPF'}, 'status')
        download.assert_called_once(); self.assertEqual(result['lastBackup']['snapshotId'], self.manifest['snapshotId'])


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(dir=TEST_TEMP); self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.ops = self.root / 'ops'; self.ops.mkdir(); (self.ops / 'recipient.txt').write_text('age1fixture')
        for name in ('.env', 'compose.yaml', 'worker/Dockerfile', 'worker/package.json', 'worker/package-lock.json', 'worker/tsconfig.json', 'worker/harness/package.json', 'worker/harness/src/example.txt', 'worker/src/example.txt', 'dynamicconfig/example.txt', 'scripts/example.txt'):
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('synthetic configuration')
        self.calls = []
        for attribute, value in [('ROOT', self.root), ('OPS', self.ops), ('BACKUPS', self.root / 'backups/sealed'), ('AGE', self.ops / 'age')]:
            patcher = patch.object(server, attribute, value); patcher.start(); self.addCleanup(patcher.stop)
        self.states = {name: {'status': 'running', 'health': 'healthy', 'image': 'sha256:fixture', 'containerId': 'id-' + name} for name in ('postgres', 'temporal', 'worker', 'ui')}

    def fake_stop(self, services): self.calls.append('stop')

    def fake_resume(self, services): self.calls.append('resume')

    def fake_dump(self, args, **kwargs): kwargs['stdout'].write(b'PGDMP-fixture'); return types.SimpleNamespace(returncode=0)

    def fake_encrypt(self, args, **kwargs):
        with tarfile.open(args[5]) as archive: self.archived_names = archive.getnames()
        Path(args[4]).write_bytes(b'age-encryption.org/v1\nencrypted fixture'); return b''

    def test_consistent_pair_and_resumption_before_sealing(self):
        with patch.object(server, 'service_states', return_value=self.states), patch.object(server, 'stop_writers', side_effect=self.fake_stop), patch.object(server, 'resume_writers', side_effect=self.fake_resume), patch.object(server.subprocess, 'run', side_effect=self.fake_dump), patch.object(server, 'execute', side_effect=self.fake_encrypt):
            result = server.snapshot()
        self.assertEqual(self.calls, ['stop', 'resume'])
        self.assertTrue(result['sourceServicesResumed']); self.assertEqual(set(result['databaseHashes']), {'temporal.dump', 'temporal_visibility.dump'})
        for name in ('runtime/worker/tsconfig.json', 'runtime/worker/harness/package.json', 'runtime/worker/harness/src/example.txt'):
            self.assertIn(name, self.archived_names)
        self.assertFalse(list((self.root / 'backups/sealed').glob('sf-backup-*')))

    def test_dump_failure_always_attempts_resumption(self):
        with patch.object(server, 'service_states', return_value=self.states), patch.object(server, 'stop_writers', side_effect=self.fake_stop), patch.object(server, 'resume_writers', side_effect=self.fake_resume), patch.object(server.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'synthetic dump')), self.assertRaises(subprocess.CalledProcessError):
            server.snapshot()
        self.assertEqual(self.calls, ['stop', 'resume'])
        self.assertFalse(list((self.root / 'backups/sealed').glob('sf-backup-*')))

    def test_unhealthy_source_is_not_stopped(self):
        self.states['temporal']['health'] = 'unhealthy'
        with patch.object(server, 'service_states', return_value=self.states), patch.object(server, 'stop_writers') as stop, self.assertRaises(ValueError): server.snapshot()
        stop.assert_not_called()

    def test_resume_uses_original_container_ids(self):
        with patch.object(server, 'service_states', return_value=self.states), patch.object(server, 'execute') as execute:
            server.resume_writers(self.states)
        self.assertEqual([call.args[0] for call in execute.call_args_list], [['docker', 'start', 'id-temporal'], ['docker', 'start', 'id-worker']])

    def test_changed_configuration_is_not_published(self):
        def change_config(services):
            self.fake_resume(services); (self.root / '.env').write_text('concurrent configuration change')
        with patch.object(server, 'service_states', return_value=self.states), patch.object(server, 'stop_writers', side_effect=self.fake_stop), patch.object(server, 'resume_writers', side_effect=change_config), patch.object(server.subprocess, 'run', side_effect=self.fake_dump), self.assertRaises(ValueError):
            server.snapshot()
        self.assertFalse(list((self.root / 'backups/sealed').glob('*.json')))


if __name__ == '__main__': unittest.main(verbosity=2)
