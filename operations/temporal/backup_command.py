#!/usr/bin/python3
"""Root-owned forced SSH command. Never accepts paths, recipients or shell code."""
import fcntl
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from protocol import admit

ROOT = Path('/docker/sf-temporal')
OPS = ROOT / 'ops'
BACKUPS = ROOT / 'backups' / 'sealed'
AGE = OPS / 'bin' / 'age'
SERVICES = ('postgres', 'temporal', 'worker', 'ui')
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root', 'LC_ALL': 'C'}


def execute(args, timeout=120, **kwargs):
    return subprocess.run(args, cwd=ROOT, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          timeout=timeout, check=True, **kwargs).stdout


def validate_root():
    if os.geteuid() != 0 or ROOT.resolve() != ROOT:
        raise ValueError('UNTRUSTED_ROOT')
    for path in (ROOT, OPS, OPS / 'protocol.py', OPS / 'backup_command.py', OPS / 'health.mjs', OPS / 'recipient.txt', AGE):
        stat = path.stat()
        if path.is_symlink() or stat.st_uid != 0 or stat.st_mode & 0o022:
            raise ValueError('UNTRUSTED_OPERATION_FILE')


def service_states():
    raw = json.loads(execute(['docker', 'inspect', *('sf-temporal-' + name + '-1' for name in SERVICES)]))
    return {c['Config']['Labels']['com.docker.compose.service']: {
        'status': c['State']['Status'], 'health': c['State'].get('Health', {}).get('Status'),
        'image': c['Image'], 'containerId': c['Id'], 'startedAt': c['State']['StartedAt'],
        'memoryLimitBytes': c['HostConfig']['Memory'], 'cpuLimitNanos': c['HostConfig']['NanoCpus'],
    } for c in raw}


def stop_writers(services):
    execute(['docker', 'stop', '--time', '30', services['worker']['containerId'], services['temporal']['containerId']], timeout=90)


def resume_writers(services):
    # Restart the exact original containers. Never re-evaluate possibly changed Compose/config files.
    execute(['docker', 'start', services['temporal']['containerId']], timeout=30)
    deadline = time.monotonic() + 90
    while True:
        current = service_states()
        if current['temporal']['containerId'] != services['temporal']['containerId']:
            raise ValueError('SOURCE_CONTAINER_REPLACED')
        if current['temporal']['status'] == 'running' and current['temporal']['health'] in ('healthy', None): break
        if time.monotonic() > deadline: raise ValueError('TEMPORAL_RESTART_TIMEOUT')
        time.sleep(2)
    execute(['docker', 'start', services['worker']['containerId']], timeout=30)
    current = service_states()
    if any(current[n]['containerId'] != services[n]['containerId'] or current[n]['status'] != 'running' for n in ('postgres', 'temporal', 'worker')):
        raise ValueError('SOURCE_NOT_RESUMED')


def status():
    services = service_states()
    try:
        raw = execute(['docker', 'run', '--rm', '--network', 'sf-temporal_backend', '--memory', '256m',
                       '--cpus', '0.3', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                       '-v', str(OPS / 'health.mjs') + ':/app/ops-health.mjs:ro', '--entrypoint', 'node', services['worker']['image'],
                       '/app/ops-health.mjs'], timeout=25)
        temporal = json.loads(raw)
    except (subprocess.SubprocessError, ValueError):
        temporal = {'ok': False, 'code': 'TEMPORAL_PROBE_FAILED'}
    latest = None
    for manifest in sorted(BACKUPS.glob('*.json'), reverse=True):
        if not manifest.is_symlink() and manifest.with_suffix('.tar.gz.age').is_file():
            latest = json.loads(manifest.read_text()); break
    return {'ok': True, 'services': services, 'temporal': temporal, 'latestSnapshot': latest,
            'checkedAt': datetime.now(timezone.utc).isoformat()}


def snapshot():
    services = service_states()
    if any(services[name]['status'] != 'running' or services[name]['health'] not in ('healthy', None) for name in ('postgres', 'temporal', 'worker')):
        raise ValueError('SOURCE_NOT_RUNNING')
    recipient = (OPS / 'recipient.txt').read_text().strip()
    if not recipient.startswith('age1') or len(recipient) > 100:
        raise ValueError('INVALID_RECIPIENT')
    BACKUPS.mkdir(mode=0o700, parents=True, exist_ok=True)
    identifier = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + secrets.token_hex(4)
    cipher = BACKUPS / (identifier + '.tar.gz.age')
    temporary = Path(tempfile.mkdtemp(prefix='sf-backup-', dir=BACKUPS))
    os.chmod(temporary, 0o700)
    stopping_attempted = False
    try:
        runtime = temporary / 'runtime'; runtime.mkdir()
        runtime_names = ('.env', 'compose.yaml', 'dynamicconfig', 'scripts', 'worker/src',
                         'worker/Dockerfile', 'worker/package.json', 'worker/package-lock.json', 'ops')
        for name in runtime_names:
            source = ROOT / name; target = runtime / name; target.parent.mkdir(parents=True, exist_ok=True)
            if source.is_dir(): shutil.copytree(source, target, symlinks=True)
            else: shutil.copy2(source, target, follow_symlinks=False)
        stopping_attempted = True
        stop_writers(services)
        for database in ('temporal', 'temporal_visibility'):
            with (temporary / (database + '.dump')).open('wb') as out:
                subprocess.run(['docker', 'exec', 'sf-temporal-postgres-1', 'pg_dump', '-U', 'temporal_admin',
                                '-d', database, '-Fc'], env=ENV, stdout=out, stderr=subprocess.PIPE,
                               timeout=120, check=True)
        resume_writers(services)
        stopping_attempted = False
        for name in ('.env', 'compose.yaml'):
            if hashlib.sha256((runtime / name).read_bytes()).digest() != hashlib.sha256((ROOT / name).read_bytes()).digest():
                raise ValueError('RUNTIME_CONFIGURATION_CHANGED')
        archive_path = temporary / 'backup.tar.gz'
        metadata = {'createdAt': datetime.now(timezone.utc).isoformat(), 'snapshotId': identifier,
                    'namespace': 'software-factory-poc', 'services': services,
                    'databaseHashes': {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in temporary.glob('*.dump')}}
        (temporary / 'snapshot.json').write_text(json.dumps(metadata))
        with tarfile.open(archive_path, 'w:gz') as archive:
            for name in ('temporal.dump', 'temporal_visibility.dump', 'snapshot.json'):
                archive.add(temporary / name, arcname=name)
            archive.add(runtime, arcname='runtime')
        execute([str(AGE), '-r', recipient, '-o', str(cipher), str(archive_path)], timeout=180)
        os.chmod(cipher, 0o600)
        metadata.update({'sha256': hashlib.sha256(cipher.read_bytes()).hexdigest(), 'bytes': cipher.stat().st_size,
                         'recipient': recipient, 'format': 'age', 'sourceServicesResumed': True})
        manifest = BACKUPS / (identifier + '.json')
        manifest.write_text(json.dumps(metadata)); os.chmod(manifest, 0o600)
        return metadata
    finally:
        try:
            if stopping_attempted:
                resume_writers(services)
        finally:
            # Only this fresh mkdtemp directory is disposable; never remove a caller-supplied path.
            if temporary.parent.resolve() == BACKUPS.resolve() and temporary.name.startswith('sf-backup-'):
                shutil.rmtree(temporary)


def main():
    os.umask(0o077)
    operation, identifier = admit(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
    validate_root()
    OPS.mkdir(mode=0o700, exist_ok=True)
    with (OPS / 'operation.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if operation == 'status':
            print(json.dumps(status()))
        elif operation == 'snapshot':
            print(json.dumps(snapshot()))
        else:
            cipher = BACKUPS / (identifier + '.tar.gz.age')
            if cipher.is_symlink() or cipher.resolve().parent != BACKUPS.resolve() or not (BACKUPS / (identifier + '.json')).is_file():
                raise ValueError('SNAPSHOT_NOT_FOUND')
            with cipher.open('rb') as source:
                shutil.copyfileobj(source, sys.stdout.buffer)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Exception text can contain command arguments or private configuration. Emit only its class.
        print(json.dumps({'ok': False, 'code': 'OPERATION_FAILED', 'type': type(exc).__name__}), file=sys.stderr)
        sys.exit(1)
