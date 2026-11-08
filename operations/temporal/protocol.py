"""Fixed-command admission and alert policy shared by the operations tools."""
import re
from datetime import datetime, timezone

SNAPSHOT = re.compile(r'\A[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}\Z')


def admit(command):
    if command in ('status', 'snapshot'):
        return command, None
    if command.startswith('fetch ') and SNAPSHOT.fullmatch(command[6:]):
        return 'fetch', command[6:]
    raise ValueError('COMMAND_NOT_ALLOWED')


def evaluate(status, last_backup_at, now=None):
    now = now or datetime.now(timezone.utc)
    alerts = []
    if status.get('ok') is not True:
        alerts.append('STATUS_UNAVAILABLE')
    for name in ('postgres', 'temporal', 'worker', 'ui'):
        service = status.get('services', {}).get(name, {})
        if service.get('status') != 'running' or service.get('health') not in ('healthy', None):
            alerts.append('SERVICE_UNAVAILABLE:' + name)
    probe = status.get('temporal', {})
    if probe.get('ok') is not True:
        alerts.append('TEMPORAL_UNAVAILABLE')
    metrics = probe.get('metrics', {})
    if metrics.get('maximumPendingTaskAgeSeconds', 0) > 300:
        alerts.append('QUEUE_WAIT_OVER_5_MINUTES')
    if metrics.get('maximumActivityAttempt', 0) >= 3:
        alerts.append('ACTIVITY_RETRY_OVER_BUDGET')
    if metrics.get('recentTimedOutWorkflows', 0):
        alerts.append('WORKFLOW_TIMEOUT')
    if not last_backup_at:
        alerts.append('OFFSITE_BACKUP_MISSING')
    else:
        age = (now - datetime.fromisoformat(last_backup_at.replace('Z', '+00:00'))).total_seconds()
        if age < -60:
            alerts.append('BACKUP_CLOCK_INVALID')
        elif age > 86400:
            alerts.append('OFFSITE_BACKUP_OLDER_THAN_24_HOURS')
    return sorted(set(alerts))
