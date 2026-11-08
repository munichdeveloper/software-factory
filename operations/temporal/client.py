"""Local collector. Slack delivery is performed by the connected scheduled task."""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from protocol import SNAPSHOT, evaluate


def write_json(path, value):
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, indent=2)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)


def load_config(path):
    config = json.loads(path.read_text(encoding='utf-8-sig'))
    if not isinstance(config.get('enabled'), bool): raise ValueError('BOOLEAN_ACTIVATION_REQUIRED')
    if config['host'] != '187.126.26.9' or config['user'] != 'root' or config['channelId'] != 'C0A5XUJFZPF':
        raise ValueError('UNEXPECTED_DESTINATION')
    if config['recipient'].count('\n') or not config['recipient'].startswith('age1'):
        raise ValueError('INVALID_RECIPIENT')
    for key in ('privateKey', 'knownHosts', 'backupDirectory'):
        if not Path(config[key]).is_absolute(): raise ValueError('ABSOLUTE_PATH_REQUIRED')
    return config


def ssh_args(config, command):
    return ['ssh', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=15',
            '-o', 'ServerAliveCountMax=2', '-o', 'UserKnownHostsFile=' + config['knownHosts'],
            '-i', config['privateKey'], config['user'] + '@' + config['host'], command]


def remote_json(config, command, timeout=45):
    result = subprocess.run(ssh_args(config, command), capture_output=True, timeout=timeout)
    if result.returncode or len(result.stdout) > 524288:
        raise RuntimeError('REMOTE_OPERATION_FAILED')
    return json.loads(result.stdout)


def ui_check():
    try:
        with urllib.request.urlopen(urllib.request.Request('https://temporal.srv2127002.hstgr.cloud/', method='HEAD'), timeout=10) as response:
            return False  # An anonymously accessible page is an authentication regression.
    except urllib.error.HTTPError as error:
        return error.code == 401 and 'basic' in error.headers.get('WWW-Authenticate', '').lower()
    except OSError:
        return False


def validate_manifest(config, manifest):
    if not SNAPSHOT.fullmatch(manifest.get('snapshotId', '')): raise ValueError('INVALID_SNAPSHOT_ID')
    if not re.fullmatch('[a-f0-9]{64}', manifest.get('sha256', '')): raise ValueError('INVALID_HASH')
    if not isinstance(manifest.get('bytes'), int) or not 0 < manifest['bytes'] <= 536870912:
        raise ValueError('INVALID_SIZE')
    if manifest.get('recipient') != config['recipient'] or manifest.get('format') != 'age':
        raise ValueError('WRONG_ENCRYPTION_RECIPIENT')
    if manifest.get('sourceServicesResumed') is not True: raise ValueError('SOURCE_NOT_RESUMED')
    timestamp = datetime.fromisoformat(manifest['createdAt'].replace('Z', '+00:00'))
    if timestamp.tzinfo is None or (timestamp - datetime.now(timezone.utc)).total_seconds() > 60:
        raise ValueError('INVALID_SNAPSHOT_TIME')


def download(config, manifest):
    validate_manifest(config, manifest)
    directory = Path(config['backupDirectory']); directory.mkdir(parents=True, exist_ok=True)
    final = directory / (manifest['snapshotId'] + '.tar.gz.age')
    if final.exists():
        if final.stat().st_size != manifest['bytes'] or hashlib.sha256(final.read_bytes()).hexdigest() != manifest['sha256']:
            raise ValueError('EXISTING_BACKUP_MISMATCH')
        return final
    partial = final.with_suffix(final.suffix + '.part')
    if partial.exists(): raise ValueError('PARTIAL_BACKUP_NEEDS_REVIEW')
    try:
        with partial.open('xb') as stream:
            result = subprocess.run(ssh_args(config, 'fetch ' + manifest['snapshotId']), stdout=stream,
                                    stderr=subprocess.PIPE, timeout=600)
            stream.flush(); os.fsync(stream.fileno())
        if result.returncode or partial.stat().st_size != manifest['bytes'] or hashlib.sha256(partial.read_bytes()).hexdigest() != manifest['sha256']:
            raise ValueError('BACKUP_TRANSFER_FAILED')
        with partial.open('rb') as stream:
            header = b'age-encryption.org/v1\n'
            if stream.read(len(header)) != header: raise ValueError('INVALID_AGE_HEADER')
        os.replace(partial, final)
        write_json(directory / (manifest['snapshotId'] + '.json'), manifest)
        return final
    finally:
        if partial.exists(): partial.unlink()


def incidents(state, codes, now):
    active = state.setdefault('incidents', {})
    deliveries = state.setdefault('deliveries', {})
    for code in codes:
        if code not in active:
            delivery_id = hashlib.sha256((code + ':' + now).encode()).hexdigest()[:24]
            active[code] = {'openedAt': now, 'deliveryId': delivery_id}
            deliveries[delivery_id] = {'status': 'pending', 'code': code, 'kind': 'incident', 'openedAt': now}
    for code in list(active):
        if code not in codes:
            previous = active[code]
            delivery = deliveries[previous['deliveryId']]
            if delivery['status'] == 'unknown':
                previous['resolvedAt'] = now
                continue
            active.pop(code)
            if delivery['status'] == 'pending':
                delivery['status'] = 'cancelled_before_send'
            if delivery['status'] == 'sent':
                identifier = hashlib.sha256((previous['deliveryId'] + ':recovered').encode()).hexdigest()[:24]
                deliveries[identifier] = {'status': 'pending', 'code': code, 'kind': 'recovery', 'openedAt': now}
    return [{'deliveryId': identifier, **delivery} for identifier, delivery in deliveries.items() if delivery['status'] in ('pending', 'unknown')]


def collect(config, state, force_backup=False):
    if not config.get('enabled'):
        return {'activation': 'pending_approval', 'alerts': [], 'pendingDeliveries': []}
    now = datetime.now(timezone.utc)
    codes = []
    try: status = remote_json(config, 'status')
    except Exception: status = {'ok': False}
    last = state.get('lastBackup')
    locally_verified = False
    if last:
        try:
            validate_manifest(config, last)
            archive = Path(config['backupDirectory']) / (last['snapshotId'] + '.tar.gz.age')
            locally_verified = archive.stat().st_size == last['bytes'] and hashlib.sha256(archive.read_bytes()).hexdigest() == last['sha256']
        except (OSError, ValueError, KeyError):
            locally_verified = False
        if not locally_verified: codes.append('OFFSITE_BACKUP_LOCAL_VERIFICATION_FAILED')
    due = not locally_verified or (now - datetime.fromisoformat(last['createdAt'].replace('Z', '+00:00'))).total_seconds() >= 72000
    if force_backup or due:
        try:
            if status.get('ok') is not True or status.get('temporal', {}).get('ok') is not True:
                raise ValueError('UNHEALTHY_SOURCE')
            manifest = status.get('latestSnapshot') if not force_backup else None
            if manifest:
                validate_manifest(config, manifest)
                if (now - datetime.fromisoformat(manifest['createdAt'].replace('Z', '+00:00'))).total_seconds() >= 72000:
                    manifest = None
            if not manifest: manifest = remote_json(config, 'snapshot', timeout=600)
            download(config, manifest)
            state['lastBackup'] = manifest
            if 'OFFSITE_BACKUP_LOCAL_VERIFICATION_FAILED' in codes:
                codes.remove('OFFSITE_BACKUP_LOCAL_VERIFICATION_FAILED')
        except Exception:
            codes.append('BACKUP_ATTEMPT_FAILED')
    last = state.get('lastBackup')
    codes += evaluate(status, last['createdAt'] if last else None, now)
    if not ui_check(): codes.append('HTTPS_AUTH_OR_REACHABILITY_FAILED')
    checked_at = now.isoformat()
    pending = incidents(state, sorted(set(codes)), checked_at)
    state['lastCheckAt'] = checked_at
    return {'activation': 'enabled', 'checkedAt': checked_at, 'alerts': sorted(set(codes)),
            'pendingDeliveries': pending, 'status': status, 'lastBackup': last,
            'channelId': config['channelId']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, type=Path)
    parser.add_argument('--force-backup', action='store_true')
    parser.add_argument('--ack')
    parser.add_argument('--permalink')
    parser.add_argument('--unknown')
    args = parser.parse_args()
    config = load_config(args.config)
    state_path = args.config.parent / 'state.json'
    lock_path = args.config.parent / 'run.lock'
    descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
        if args.ack or args.unknown:
            identifier = args.ack or args.unknown
            delivery = state['deliveries'][identifier]
            if args.ack:
                if not args.permalink or not args.permalink.startswith('https://digitalsmallbusiness.slack.com/archives/C0A5XUJFZPF/p'):
                    raise ValueError('UNEXPECTED_SLACK_RECEIPT')
                delivery.update(status='sent', permalink=args.permalink)
            else: delivery['status'] = 'unknown'
            result = {'deliveryId': identifier, 'status': delivery['status']}
        else: result = collect(config, state, args.force_backup)
        write_json(state_path, state)
        write_json(args.config.parent / 'last-result.json', result)
        print(json.dumps(result))
    finally:
        os.close(descriptor); lock_path.unlink()


if __name__ == '__main__':
    try: main()
    except Exception as exc:
        print(json.dumps({'ok': False, 'code': 'LOCAL_OPERATION_FAILED', 'type': type(exc).__name__}))
        sys.exit(1)
