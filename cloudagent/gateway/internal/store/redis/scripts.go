package redis

// Lua scripts for atomic Redis operations.
// All scripts use KEYS and ARGV to remain cluster-safe.

// acquireRuntimeOwnershipScript atomically acquires or steals a runtime
// ownership lease. A lease can be acquired when:
//   - No active lease exists for the session
//   - The existing lease has expired (expires_at <= now)
//   - AllowSameOwner is set and the current holder matches
//
// KEYS[1] = gw:rt-own:{session_id}
// ARGV[1] = generation
// ARGV[2] = run_id
// ARGV[3] = owner_id
// ARGV[4] = operation
// ARGV[5] = now (RFC3339Nano)
// ARGV[6] = expires_at (RFC3339Nano)
// ARGV[7] = allow_same_owner ("1" or "0")
// ARGV[8] = grace_ttl_ms
//
// Returns: "OK" on success, or "HELD:<json>" on conflict.
const acquireRuntimeOwnershipScript = `
local key = KEYS[1]
local new_gen = ARGV[1]
local new_run = ARGV[2]
local new_owner = ARGV[3]
local new_op = ARGV[4]
local now = ARGV[5]
local new_expires = ARGV[6]
local allow_same = ARGV[7]
local grace_ms = tonumber(ARGV[8])

local state = redis.call('HGET', key, 'state')
if state == 'active' then
  local cur_expires = redis.call('HGET', key, 'expires_at')
  if cur_expires > now then
    -- Not expired yet, check same-owner exception
    if allow_same == '1' then
      local cur_owner = redis.call('HGET', key, 'owner_id')
      if cur_owner ~= new_owner then
        return 'HELD:' .. redis.call('HGET', key, '_json')
      end
    else
      return 'HELD:' .. redis.call('HGET', key, '_json')
    end
  end
end

-- Acquire: increment fencing token
local token = redis.call('HINCRBY', key, 'fencing_token', 1)
redis.call('HMSET', key,
  'generation', new_gen,
  'run_id', new_run,
  'owner_id', new_owner,
  'operation', new_op,
  'state', 'active',
  'expires_at', new_expires,
  'heartbeat_at', now,
  'created_at', now,
  'updated_at', now)
-- Store a JSON snapshot for error reporting
local json = '{"session_id":"' .. key .. '","generation":' .. new_gen ..
  ',"run_id":"' .. new_run .. '","owner_id":"' .. new_owner ..
  '","operation":"' .. new_op .. '","fencing_token":' .. token ..
  ',"expires_at":"' .. new_expires .. '"}'
redis.call('HSET', key, '_json', json)
redis.call('PEXPIRE', key, grace_ms)
return 'OK:' .. token
`

// renewRuntimeOwnershipScript extends the TTL of an active lease.
// Only succeeds if the caller's identity (generation, run_id, owner_id, fencing_token) matches.
//
// KEYS[1] = gw:rt-own:{session_id}
// ARGV[1] = generation
// ARGV[2] = run_id
// ARGV[3] = owner_id
// ARGV[4] = fencing_token
// ARGV[5] = new_expires_at (RFC3339Nano)
// ARGV[6] = now (RFC3339Nano)
// ARGV[7] = grace_ttl_ms
//
// Returns: "OK" or "LOST"
const renewRuntimeOwnershipScript = `
local key = KEYS[1]
local gen = ARGV[1]
local run = ARGV[2]
local owner = ARGV[3]
local fence = ARGV[4]
local new_expires = ARGV[5]
local now = ARGV[6]
local grace_ms = tonumber(ARGV[7])

local cur_gen = redis.call('HGET', key, 'generation')
local cur_run = redis.call('HGET', key, 'run_id')
local cur_owner = redis.call('HGET', key, 'owner_id')
local cur_fence = redis.call('HGET', key, 'fencing_token')
local cur_state = redis.call('HGET', key, 'state')

if cur_state ~= 'active' or cur_gen ~= gen or cur_run ~= run or cur_owner ~= owner or cur_fence ~= fence then
  return 'LOST'
end

redis.call('HMSET', key, 'expires_at', new_expires, 'heartbeat_at', now, 'updated_at', now)
redis.call('PEXPIRE', key, grace_ms)
return 'OK'
`

// releaseRuntimeOwnershipScript marks a lease as released.
//
// KEYS[1] = gw:rt-own:{session_id}
// ARGV[1] = generation
// ARGV[2] = run_id
// ARGV[3] = owner_id
// ARGV[4] = fencing_token
// ARGV[5] = now (RFC3339Nano)
//
// Returns: "OK" or "MISS"
const releaseRuntimeOwnershipScript = `
local key = KEYS[1]
local gen = ARGV[1]
local run = ARGV[2]
local owner = ARGV[3]
local fence = ARGV[4]
local now = ARGV[5]

local cur_gen = redis.call('HGET', key, 'generation')
local cur_run = redis.call('HGET', key, 'run_id')
local cur_owner = redis.call('HGET', key, 'owner_id')
local cur_fence = redis.call('HGET', key, 'fencing_token')

if cur_gen ~= gen or cur_run ~= run or cur_owner ~= owner or cur_fence ~= fence then
  return 'MISS'
end

redis.call('HMSET', key, 'state', 'released', 'updated_at', now)
redis.call('PEXPIRE', key, 60000)
return 'OK'
`

// checkRuntimeOwnershipScript checks if a lease is still held by the given identity.
//
// KEYS[1] = gw:rt-own:{session_id}
// ARGV[1] = generation
// ARGV[2] = run_id
// ARGV[3] = owner_id
// ARGV[4] = fencing_token
// ARGV[5] = now (RFC3339Nano)
//
// Returns: "HELD" or "LOST"
const checkRuntimeOwnershipScript = `
local key = KEYS[1]
local gen = ARGV[1]
local run = ARGV[2]
local owner = ARGV[3]
local fence = ARGV[4]
local now = ARGV[5]

local cur_gen = redis.call('HGET', key, 'generation')
local cur_run = redis.call('HGET', key, 'run_id')
local cur_owner = redis.call('HGET', key, 'owner_id')
local cur_fence = redis.call('HGET', key, 'fencing_token')
local cur_state = redis.call('HGET', key, 'state')
local cur_expires = redis.call('HGET', key, 'expires_at')

if cur_state ~= 'active' then return 'LOST' end
if cur_gen ~= gen or cur_run ~= run or cur_owner ~= owner or cur_fence ~= fence then return 'LOST' end
if cur_expires <= now then return 'LOST' end
return 'HELD'
`

// acquireRuntimeLockScript is a simple SET NX PX (Redlock-lite).
//
// KEYS[1] = gw:rt-lock:{key}
// ARGV[1] = holder_id
// ARGV[2] = ttl_ms
//
// Returns: "OK" or "HELD"
const acquireRuntimeLockScript = `
local key = KEYS[1]
local holder = ARGV[1]
local ttl = tonumber(ARGV[2])

local ok = redis.call('SET', key, holder, 'NX', 'PX', ttl)
if ok then
  return 'OK'
end
return 'HELD'
`

// releaseRuntimeLockScript releases a lock only if the holder matches.
//
// KEYS[1] = gw:rt-lock:{key}
// ARGV[1] = holder_id
//
// Returns: "OK" or "MISS"
const releaseRuntimeLockScript = `
local key = KEYS[1]
local holder = ARGV[1]

local cur = redis.call('GET', key)
if cur == holder then
  redis.call('DEL', key)
  return 'OK'
end
return 'MISS'
`
