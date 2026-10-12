package instance

import (
	pctx "ctl/pkg/context"
	"ctl/pkg/errcode"
	"ctl/pkg/transport"
)

// WeixinAccountOccupiedError exposes only the authorized owning Bot, never credentials.
type WeixinAccountOccupiedError struct {
	Owner *transport.InstanceChannelBindingResponse
}

func (e *WeixinAccountOccupiedError) Error() string {
	return "weixin account is already connected to another bot"
}
func (e *WeixinAccountOccupiedError) Unwrap() error { return errcode.ErrWeixinAccountOccupied }
func (e *WeixinAccountOccupiedError) ErrorDetail() any {
	return map[string]any{"occupied_by_bot": e.Owner}
}

func (l *logic) channelBindingFailure(ctx pctx.Context, instanceID string, binding *channelBindingPayload) error {
	if binding.Reason == "recovery_failed" {
		return errcode.ErrWeixinRecoveryFailed
	}
	if binding.Reason != "account_occupied" {
		return errcode.Wrap(errcode.ErrInstanceBotConflict, "channel binding: %s", binding.Reason)
	}
	owner, err := l.getInstanceBotResponse(ctx, instanceID, binding.BotID)
	if err != nil {
		return err
	}
	return &WeixinAccountOccupiedError{Owner: &transport.InstanceChannelBindingResponse{
		Channel: uniqueChannelWeixin, BotID: owner.BotID, BotName: owner.Name, ProfileID: owner.ProfileID, Status: "connected",
	}}
}

// BotChannelOccupiedError preserves the channel through HTTP error serialization.
type BotChannelOccupiedError struct{ Channel string }

func (e *BotChannelOccupiedError) Error() string    { return "disconnect channel before deleting bot" }
func (e *BotChannelOccupiedError) Unwrap() error    { return errcode.ErrChannelOccupied }
func (e *BotChannelOccupiedError) ErrorDetail() any { return map[string]string{"channel": e.Channel} }

// This script runs inside the Hermes virtualenv; backup credentials stay private on the instance.
const weixinAccountBindingFunctions = `import copy
import shutil
import subprocess


def weixin_profile_home(home, profile_id):
    return home if profile_id in ('', 'main', 'default') else home / 'profiles' / profile_id


def weixin_config(profile_home):
    path = profile_home / 'config.yaml'
    if not path.exists():
        return {}
    import yaml
    value = yaml.safe_load(path.read_text(encoding='utf-8')) or {}
    if not isinstance(value, dict):
        raise ValueError('invalid profile config')
    return value


def weixin_credentials(home, profile_id):
    from dotenv import dotenv_values
    profile_home = weixin_profile_home(home, profile_id)
    env = dotenv_values(profile_home / '.env', interpolate=False)
    platform = weixin_config(profile_home).get('platforms', {}).get('weixin', {}) or {}
    extra = platform.get('extra', {}) or {}
    account_id = str(extra.get('account_id') or env.get('WEIXIN_ACCOUNT_ID') or '').strip()
    user_id = ''
    account_root = profile_home / 'weixin' / 'accounts'
    account_file = account_root / (account_id + '.json')
    if account_id and account_file.resolve().is_relative_to(account_root.resolve()) and account_file.is_file():
        payload = json.loads(account_file.read_text(encoding='utf-8'))
        user_id = str(payload.get('user_id') or '').strip()
    return {'account_id': account_id, 'user_id': user_id}


def weixin_snapshot(home, root, profile_id, current):
    from dotenv import dotenv_values
    profile_home = weixin_profile_home(home, profile_id)
    backup = root / 'weixin-scans' / profile_id
    backup.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(backup.parent, 0o700)
    os.chmod(backup, 0o700)
    gateway_running = bool(current and current.get('status') == 'connected')
    if (profile_home / 'gateway.pid').exists() or (profile_home / 'gateway_state.json').exists():
        # Runtime status helpers are optional across Hermes versions. Do not make
        # a private CLI function a prerequisite for claiming a channel.
        try:
            from gateway.status import get_running_pid, read_runtime_status, get_runtime_status_running_pid
            gateway_running = bool(get_running_pid(profile_home / 'gateway.pid', cleanup_stale=False) or
                get_runtime_status_running_pid(read_runtime_status(profile_home / 'gateway_state.json'), expected_home=profile_home))
        except (ImportError, AttributeError, OSError, ValueError, TypeError):
            gateway_running = True  # Conservatively restore gateways used by other channels.
    state = {
        'binding': current,
        'gateway_running': gateway_running,
        'env': {key: value for key, value in dotenv_values(profile_home / '.env', interpolate=False).items() if key.startswith('WEIXIN_')},
        'platform': weixin_config(profile_home).get('platforms', {}).get('weixin'),
    }
    path = backup / 'state.json'
    path.write_text(json.dumps(state), encoding='utf-8')
    os.chmod(path, 0o600)
    if (profile_home / 'weixin').is_dir():
        shutil.copytree(profile_home / 'weixin', backup / 'weixin', dirs_exist_ok=True)
        for child in (backup / 'weixin').rglob('*'):
            os.chmod(child, 0o700 if child.is_dir() else 0o600)


def weixin_rollback(home, root, profile_id, current, write_current, clear_current, gateway_command):
    from dotenv import dotenv_values, set_key, unset_key
    backup = root / 'weixin-scans' / profile_id
    pending = {**current, 'status': 'recovery_required'}
    write_current(pending)
    try:
        state = json.loads((backup / 'state.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return False
    agent = 'main' if profile_id == 'default' else profile_id
    # Stop only the rejected Profile; never manipulate the owning Bot's gateway.
    stopped = gateway_command(['acli', 'gateway', 'stop', '--agent', agent], 45)
    try:
        profile_home = weixin_profile_home(home, profile_id)
        env_path = profile_home / '.env'
        for key in dotenv_values(env_path, interpolate=False):
            if key.startswith('WEIXIN_'):
                unset_key(env_path, key)
        for key, value in state['env'].items():
            if value is not None:
                set_key(env_path, key, value)
        if env_path.exists():
            os.chmod(env_path, 0o600)
        config_path = profile_home / 'config.yaml'
        if config_path.exists() or state['platform'] is not None:
            import yaml
            config = weixin_config(profile_home)
            platforms = config.setdefault('platforms', {})
            if state['platform'] is None:
                platforms.pop('weixin', None)
            else:
                platforms['weixin'] = state['platform']
            temporary = config_path.with_suffix('.weixin.tmp')
            temporary.write_text(yaml.safe_dump(config, allow_unicode=True), encoding='utf-8')
            os.chmod(temporary, 0o600)
            temporary.replace(config_path)
        shutil.rmtree(profile_home / 'weixin', ignore_errors=True)
        if (backup / 'weixin').is_dir():
            shutil.copytree(backup / 'weixin', profile_home / 'weixin')
    except Exception:
        # Configuration parsers and filesystem errors must leave a retryable
        # recovery record, never a raw traceback containing credential values.
        return False
    previous = state['binding']
    if not stopped:
        return False
    if state.get('gateway_running') or (previous and previous.get('status') == 'connected'):
        if not gateway_command(['acli', 'gateway', 'restart', '--agent', agent], 60):
            return False
    if previous:
        write_current(previous)
    else:
        clear_current()
    shutil.rmtree(backup)
    return True


def manage_weixin_account(action, home, root, profile_id, bot_id, reservation_id, current, bindings, write_current, clear_current, gateway_command):
    if action == 'get':
        return current or {'ok': True}
    if action == 'claim':
        if current and current.get('bot_id') != bot_id:
            return {'ok': False, 'reason': 'occupied', 'bot_id': current.get('bot_id', '')}
        if current and current.get('status') == 'recovery_required':
            if not weixin_rollback(home, root, profile_id, current, write_current, clear_current, gateway_command):
                return {'ok': False, 'reason': 'recovery_failed'}
            current = bindings.get(profile_id)
        if current and current.get('status') == 'reserved':
            try:
                expired = datetime.now(timezone.utc) - datetime.fromisoformat(current['updated_at']) >= timedelta(minutes=10)
            except (KeyError, ValueError):
                expired = True
            if not expired:
                return {'ok': False, 'reason': 'scan_in_progress'}
            if not weixin_rollback(home, root, profile_id, current, write_current, clear_current, gateway_command):
                return {'ok': False, 'reason': 'recovery_failed'}
            current = bindings.get(profile_id)
        if current and current.get('status') == 'connected' and not current.get('account_id'):
            current = {**current, **weixin_credentials(home, profile_id)}
        weixin_snapshot(home, root, profile_id, copy.deepcopy(current))
        result = {**(current or {}), 'ok': True, 'channel': 'weixin', 'bot_id': bot_id,
                  'profile_id': profile_id, 'status': 'reserved',
                  'reservation_id': secrets.token_urlsafe(24), 'updated_at': datetime.now(timezone.utc).isoformat()}
        write_current(result)
        return result
    if action == 'confirm':
        if not current or current.get('bot_id') != bot_id or current.get('status') != 'reserved' or (reservation_id and current.get('reservation_id') != reservation_id):
            return {'ok': False, 'reason': 'owner_mismatch'}
        identity = weixin_credentials(home, profile_id)
        if not identity['account_id']:
            return {'ok': False, 'reason': 'credentials_missing'}
        for other_profile, owner in bindings.items():
            if other_profile == profile_id or owner.get('status') not in ('connected', 'reserved', 'recovery_required'):
                continue
            # Reserved reconnects keep their previous account identity. New scans have none.
            other = owner if owner.get('account_id') else (weixin_credentials(home, other_profile) if owner.get('status') == 'connected' else {})
            if identity['account_id'] == other.get('account_id') or (identity['user_id'] and identity['user_id'] == other.get('user_id')):
                conflict = {'ok': False, 'reason': 'account_occupied', 'bot_id': owner.get('bot_id', ''), 'profile_id': other_profile}
                if not weixin_rollback(home, root, profile_id, current, write_current, clear_current, gateway_command):
                    return {'ok': False, 'reason': 'recovery_failed'}
                return conflict
        current.update({**identity, 'ok': True, 'status': 'connected', 'updated_at': datetime.now(timezone.utc).isoformat()})
        current.pop('reservation_id', None)
        write_current(current)
        shutil.rmtree(root / 'weixin-scans' / profile_id, ignore_errors=True)
        return current
    if action in ('release', 'release_reserved', 'disconnect'):
        if not current or current.get('bot_id') != bot_id:
            return {'ok': True}
        if current.get('status') in ('reserved', 'recovery_required'):
            if reservation_id and current.get('reservation_id') != reservation_id:
                return {'ok': True}
            if not weixin_rollback(home, root, profile_id, current, write_current, clear_current, gateway_command):
                return {'ok': False, 'reason': 'recovery_failed'}
        elif action != 'release_reserved' and not weixin_credentials(home, profile_id)['account_id']:
            clear_current()
        return {'ok': True}
    return {'ok': False, 'reason': 'unsupported_action'}
`
