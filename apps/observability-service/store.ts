import { openManagedDatabase, createSchemaValidator } from '../../packages/sqlite-node/src/index.js';
import { limits, sanitizeEvent, components } from '../../packages/observability-contract/index.mjs';
export const observationSchemaV1 = `
CREATE TABLE events(seq INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, received INTEGER NOT NULL, kind TEXT NOT NULL, component TEXT NOT NULL, actor TEXT, body TEXT NOT NULL) STRICT;
CREATE INDEX events_window ON events(at,received);
CREATE INDEX events_received ON events(received);
CREATE TABLE executions(domain_key TEXT PRIMARY KEY, started INTEGER, ended INTEGER, outcome TEXT NOT NULL, updated INTEGER NOT NULL) STRICT;
CREATE TABLE producers(component TEXT NOT NULL, producer TEXT NOT NULL, received INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(component,producer)) STRICT;
CREATE TABLE metrics(name TEXT NOT NULL, dimension TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY(name,dimension)) STRICT;
`;
export const observationSchemaV2 = `
CREATE INDEX events_incident ON events(json_extract(body,'$.incidentRef'),at) WHERE json_extract(body,'$.incidentRef') IS NOT NULL;
CREATE INDEX executions_window ON executions(started,ended);
CREATE TABLE activity_hours(hour INTEGER NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(hour,actor)) STRICT;
CREATE TABLE recovery_episodes(recovery_id TEXT PRIMARY KEY, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, outcome TEXT NOT NULL) STRICT;
CREATE INDEX recovery_window ON recovery_episodes(first_at,last_at);
`;
export const observationSchemaV3 = `
CREATE TABLE execution_progress(domain_key TEXT PRIMARY KEY, engine TEXT NOT NULL, stage TEXT NOT NULL, progress_at INTEGER NOT NULL, received INTEGER NOT NULL, terminal INTEGER NOT NULL) STRICT;
CREATE INDEX execution_progress_active ON execution_progress(terminal,received);
CREATE TABLE queue_samples(domain_key TEXT PRIMARY KEY, engine TEXT NOT NULL, count INTEGER NOT NULL, observed_at INTEGER NOT NULL, received INTEGER NOT NULL) STRICT;
`;
export const observationSchemaV4 = `CREATE INDEX producers_freshness ON producers(component,received DESC,producer DESC);`;
// Probe reads run on every health/metrics request; unrelated event history must not be scanned.
export const observationSchemaV5 = `CREATE INDEX events_availability ON events(at,seq) WHERE kind='availability';`;
export const observationSchemaV6 = `
CREATE TABLE connection_outages(recovery_id TEXT PRIMARY KEY, actor TEXT NOT NULL, started INTEGER NOT NULL, observed INTEGER NOT NULL, completed INTEGER NOT NULL) STRICT;
CREATE INDEX connection_outage_window ON connection_outages(observed,started);
CREATE INDEX gateway_lifecycle_window ON events(at,seq) WHERE kind='lifecycle' AND component='gateway';
`;
const backfill = `
INSERT OR IGNORE INTO activity_hours SELECT CAST(at/3600000 AS INTEGER),actor FROM events WHERE actor IS NOT NULL AND json_extract(body,'$.actorKind')='human' AND json_extract(body,'$.originClass')='interactive';
INSERT OR IGNORE INTO recovery_episodes SELECT json_extract(body,'$.recoveryId'),min(at),max(at),'unknown' FROM events WHERE kind='recovery' AND json_extract(body,'$.recoveryId') IS NOT NULL GROUP BY json_extract(body,'$.recoveryId');
`;
function primarySqliteCode(error: unknown) {
  const value = error as {errcode?: number; cause?: {errcode?: number}} | null;
  const code = value?.errcode ?? value?.cause?.errcode;
  return typeof code === 'number' ? code & 0xff : undefined;
}

function isCapacityError(error: unknown) {
  if (primarySqliteCode(error) === 13) return true;
  const value = error as {message?: string; cause?: {message?: string}} | null;
  return /SQLITE_FULL|database or disk is full/i.test(String(value?.message ?? value?.cause?.message ?? ''));
}

const DEFAULT_MAX_PAGES = 110000;

export class ObserveStore {
  db; outcome; accepted = 0; rejected = 0; dropped = 0;
  readonly now: () => number;
  constructor(path: string, now: () => number = Date.now, databaseBytes?: number) {
    if (databaseBytes !== undefined && (!Number.isSafeInteger(databaseBytes) || databaseBytes < 4096)) throw new TypeError('Invalid Observe database capacity');
    this.now = now;
    const managed = openManagedDatabase({ path, legacyPolicy: 'reject', backup: {keep: 1},
      validateSchema: createSchemaValidator(observationSchemaV1+observationSchemaV2+observationSchemaV3+observationSchemaV4+observationSchemaV5+observationSchemaV6), migrations: [{version: 1, name: 'bounded-derived-observations', sql: observationSchemaV1},{version:2,name:'bounded-query-indexes-and-domain-rollups',sql:observationSchemaV2+backfill},{version:3,name:'execution-progress-and-queue-samples',sql:observationSchemaV3},{version:4,name:'latest-component-producer-index',sql:observationSchemaV4},{version:5,name:'availability-event-index',sql:observationSchemaV5},{version:6,name:'connection-outage-rollup',sql:observationSchemaV6}] });
    this.db = managed.database; this.outcome = managed.outcome;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=50; PRAGMA journal_size_limit=33554432;');
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get().page_size);
    const pageLimit = databaseBytes === undefined ? DEFAULT_MAX_PAGES : Math.floor(databaseBytes / pageSize);
    if (!Number.isSafeInteger(pageLimit) || pageLimit < 1) throw new TypeError('Invalid Observe database capacity');
    this.db.exec(`PRAGMA max_page_count=${pageLimit};`);
  }
  ingest(inputs: unknown[], actor: string | null = null) {
    let accepted = 0, rejected = 0, duplicates = 0, dropped = 0;
    const now = this.now();
    const events: Array<{event: any; body: string}> = [];
    for (const input of inputs) {
      const event = sanitizeEvent(input, now);
      if (!event) { rejected++; continue; }
      events.push({event, body: JSON.stringify(event)});
    }
    // Existing success-path identity: an event is a duplicate when its id is
    // already persisted or appeared earlier in this valid batch; otherwise it
    // would be accepted. Record that identity for the whole batch up front so
    // a late capacity rollback cannot misclassify ids that were not reached.
    const ids = [...new Set(events.map(({event}) => event.eventId))];
    const known = new Set<string>();
    if (ids.length) {
      const rows = this.db.prepare(`SELECT event_id FROM events WHERE event_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      for (const row of rows) known.add(row.event_id as string);
    }
    let plannedDuplicates = 0, plannedDropped = 0;
    for (const {event} of events) {
      if (known.has(event.eventId)) plannedDuplicates++;
      else { known.add(event.eventId); plannedDropped++; }
    }
    let transaction = false;
    try {
      this.db.exec('BEGIN'); transaction = true;
      for (const {event, body} of events) {
        try {
          const result = this.db.prepare('INSERT OR IGNORE INTO events(event_id,at,received,kind,component,actor,body) VALUES(?,?,?,?,?,?,?)')
            .run(event.eventId, event.at, now, event.kind, event.component, actor, body);
          if (!result.changes) { duplicates++; continue; }
          accepted++;
          if (actor && event.actorKind === 'human' && event.originClass === 'interactive' && event.kind === 'recovery'
            && event.measurementScope === 'connection' && event.recoveryId && Number.isFinite(event.durationMs) && event.durationMs <= limits.retentionMs) {
            this.db.prepare(`INSERT INTO connection_outages VALUES(?,?,?,?,?) ON CONFLICT(recovery_id) DO UPDATE SET
              started=MIN(connection_outages.started,excluded.started), observed=MAX(connection_outages.observed,excluded.observed),
              completed=MAX(connection_outages.completed,excluded.completed) WHERE connection_outages.actor=excluded.actor`)
              .run(event.recoveryId, actor, Math.round(event.at-event.durationMs), Math.round(event.at), event.outcome === 'ok' ? 1 : 0);
          }
          if(actor&&event.actorKind==='human'&&event.originClass==='interactive')this.db.prepare('INSERT OR IGNORE INTO activity_hours VALUES(?,?)').run(Math.floor(event.at/3600000),actor);
          if(event.kind==='recovery'&&event.recoveryId)this.db.prepare(`INSERT INTO recovery_episodes VALUES(?,?,?,?) ON CONFLICT(recovery_id) DO UPDATE SET first_at=MIN(recovery_episodes.first_at,excluded.first_at),last_at=MAX(recovery_episodes.last_at,excluded.last_at),outcome=CASE WHEN recovery_episodes.outcome='ok' THEN 'ok' ELSE excluded.outcome END`).run(event.recoveryId,event.at,event.at,event.outcome??'unknown');
          if(!['availability','lifecycle'].includes(event.kind))this.db.prepare('INSERT INTO producers VALUES(?,?,?,?) ON CONFLICT(component,producer) DO UPDATE SET received=excluded.received,body=json_patch(producers.body,excluded.body)')
            .run(event.component,event.producerId,now,body);
          const add = (name: string, dimension: string, value: number) => this.db.prepare('INSERT INTO metrics VALUES(?,?,?) ON CONFLICT(name,dimension) DO UPDATE SET value=metrics.value+excluded.value').run(name,dimension,value);
          if (event.kind === 'rpc' && event.method && event.outcome) add('rpc',JSON.stringify([event.method,event.outcome]),1);
          if(event.kind==='operation'&&event.operationType&&event.outcome&&!['started','progress'].includes(event.outcome))add('operation_outcome',JSON.stringify([event.operationType,event.outcome,event.originClass]),1);
          // Histograms describe foreground interactive successes only. Source/cache/engine
          // metadata is never inferred from request counts, a probe, or another session.
          if (event.kind === 'operation' && event.operationType && event.outcome === 'ok' && event.durationMs !== undefined && event.originClass==='interactive' && event.visibility==='visible' && event.measurementScope===(event.operationType==='navigation'?'navigation':'in_page')) {
            const dimension=JSON.stringify([event.operationType,event.cache??'unknown',event.engine??'unknown']);
            for (const le of [.05,.1,.25,.5,1,2,5,10,30,60,Infinity]) if (event.durationMs / 1000 <= le) add('foreground_operation_bucket',JSON.stringify([event.operationType,event.cache??'unknown',event.engine??'unknown',le===Infinity?'+Inf':le]),1);
            add('foreground_operation_count',dimension,1);add('foreground_operation_sum',dimension,event.durationMs/1000);
          }
          // Dedicated series preserve the existing histogram's label schema and history.
          if (event.kind === 'operation' && event.operationType === 'thread_history_first_paint' && event.outcome && !['started','progress'].includes(event.outcome)) {
            const dimensions = [event.cache ?? 'unknown', event.lengthBucket ?? 'unknown', event.engine ?? 'unknown'];
            add('history_paint_outcome', JSON.stringify([...dimensions, event.outcome, event.originClass]), 1);
            if (event.outcome === 'ok' && event.durationMs !== undefined && event.originClass === 'interactive' && event.visibility === 'visible' && event.measurementScope === 'in_page') {
              // Restart this derived histogram as one cohort when changing its buckets.
              // Mixing new bucket counts with old lifetime counts corrupts quantiles.
              for (const le of [.05,.1,.15,.25,.5,1,2,5,10,30,60,Infinity])
                add('history_paint_v2_bucket', JSON.stringify([...dimensions, le === Infinity ? '+Inf' : le]), event.durationMs / 1000 <= le ? 1 : 0);
              add('history_paint_v2_count', JSON.stringify(dimensions), 1);
              add('history_paint_v2_sum', JSON.stringify(dimensions), event.durationMs / 1000);
            }
          }
          if(event.kind==='queue'&&event.executionId&&event.engine&&event.count!==undefined){
            this.db.prepare(`INSERT INTO queue_samples VALUES(?,?,?,?,?) ON CONFLICT(domain_key) DO UPDATE SET count=CASE WHEN excluded.observed_at>=queue_samples.observed_at THEN excluded.count ELSE queue_samples.count END,observed_at=MAX(queue_samples.observed_at,excluded.observed_at),received=MAX(queue_samples.received,excluded.received)`).run(event.engine+':'+event.executionId,event.engine,Math.floor(event.count),event.at,now);
          }
          if (event.kind === 'execution' && event.executionId) {
            const key = `${event.engine ?? event.component}:${event.executionId}`;
            const terminal = ['ok','failed','aborted','timeout'].includes(event.outcome);
            this.db.prepare(`INSERT INTO execution_progress VALUES(?,?,?,?,?,?) ON CONFLICT(domain_key) DO UPDATE SET
              stage=CASE WHEN execution_progress.terminal=0 AND excluded.progress_at>=execution_progress.progress_at THEN excluded.stage ELSE execution_progress.stage END,
              progress_at=MAX(execution_progress.progress_at,excluded.progress_at),received=MAX(execution_progress.received,excluded.received),terminal=MAX(execution_progress.terminal,excluded.terminal)`)
              .run(key,event.engine??'unknown',event.stage??'other',event.at,now,terminal?1:0);
            this.db.prepare(`INSERT INTO executions VALUES(?,?,?,?,?) ON CONFLICT(domain_key) DO UPDATE SET
              started=COALESCE(executions.started,excluded.started), ended=COALESCE(executions.ended,excluded.ended),
              outcome=CASE WHEN excluded.ended IS NOT NULL THEN excluded.outcome ELSE executions.outcome END, updated=MAX(executions.updated,excluded.updated)`)
              .run(key,event.outcome==='started'?event.at:null,terminal?event.at:null,terminal?event.outcome:'started',now);
          }
        } catch (error) {
          if (isCapacityError(error)) throw error;
          dropped++;
        }
      }
      this.db.exec('COMMIT'); transaction = false;
    } catch (error) {
      // SQLITE_FULL can make SQLite roll back the whole transaction itself.
      // Attempt release only if needed, and never replace the original failure.
      if (transaction) { try { this.db.exec('ROLLBACK'); } catch {} }
      if (isCapacityError(error)) {
        this.rejected += rejected;
        this.dropped += plannedDropped;
        return {accepted: 0, rejected, duplicates: plannedDuplicates, dropped: plannedDropped};
      }
      throw error;
    }
    this.accepted += accepted; this.rejected += rejected; this.dropped += dropped;
    return {accepted,rejected,duplicates,dropped};
  }
  events(from: number, to: number, through: number, count = limits.rows, incidentRef: string | null = null) {
    return this.db.prepare("SELECT body,received FROM events WHERE at>=? AND at<=? AND received<=? AND (? IS NULL OR json_extract(body,'$.incidentRef')=?) ORDER BY at,seq LIMIT ?")
      .all(from,to,through,incidentRef,incidentRef,count+1).map(row => ({...JSON.parse(row.body as string), receivedAt: row.received}));
  }
  availability() {
    return this.db.prepare(`SELECT body,received FROM (
      SELECT body,received,row_number() OVER (
        PARTITION BY json_extract(body,'$.site'),json_extract(body,'$.hostId'),json_extract(body,'$.engine')
        ORDER BY at DESC,seq DESC) AS rank FROM events WHERE kind='availability'
    ) WHERE rank=1`).all().map(row => ({...JSON.parse(row.body as string),receivedAt: row.received}));
  }
  availabilityRatios(from: number, to: number) {
    return this.db.prepare(`SELECT json_extract(body,'$.site') AS site,json_extract(body,'$.hostId') AS hostId,
      json_extract(body,'$.engine') AS engine,count(*) AS count,
      avg(CASE WHEN json_extract(body,'$.outcome')='ok' THEN 1.0 ELSE 0 END) AS ratio
      FROM events WHERE kind='availability' AND at>=? AND at<=? GROUP BY site,hostId,engine`).all(from,to);
  }
  eventSummary(from: number, to: number, through: number, incidentRef: string | null = null) {
    return this.db.prepare(`SELECT kind,component,json_extract(body,'$.engine') AS engine,
      json_extract(body,'$.outcome') AS outcome,json_extract(body,'$.errorCode') AS errorCode,
      json_extract(body,'$.site') AS site,json_extract(body,'$.hostId') AS hostId,
      count(*) AS count,min(at) AS firstAt,max(at) AS lastAt
      FROM events WHERE at>=? AND at<=? AND received<=? AND (? IS NULL OR json_extract(body,'$.incidentRef')=?)
      GROUP BY kind,component,engine,outcome,errorCode,site,hostId`).all(from,to,through,incidentRef,incidentRef);
  }
  lifecycle(from: number, to: number) {
    return this.db.prepare(`SELECT body FROM events WHERE kind='lifecycle' AND at>=? AND at<=? ORDER BY at,seq`).all(from,to)
      .map(row => JSON.parse(row.body as string));
  }
  producers() {
    const latest=this.db.prepare('SELECT component,producer,received,body FROM producers WHERE component=? ORDER BY received DESC,producer DESC LIMIT 1');
    return components.flatMap(component=>{const row=latest.get(component);return row?[{...row,identity:JSON.parse(row.body as string)}]:[];});
  }
  activity(from: number, to: number) {
    const first=Math.ceil(from/3600000),last=Math.floor(to/3600000);
    return this.db.prepare(`SELECT count(DISTINCT actor) AS humans FROM (
      SELECT actor FROM activity_hours WHERE hour>=? AND hour<?
      UNION SELECT actor FROM events WHERE at>=? AND at<=? AND (at<? OR at>=?) AND actor IS NOT NULL AND json_extract(body,'$.actorKind')='human' AND json_extract(body,'$.originClass')='interactive'
    )`).get(first,last,from,to,first*3600000,last*3600000);
  }
  recoveries(from: number, to: number) {
    return this.db.prepare('SELECT count(*) AS value FROM recovery_episodes WHERE first_at<=? AND last_at>=?').get(to,from);
  }
  gatewayDisconnections(from: number, to: number) {
    return this.db.prepare(`SELECT json_extract(body,'$.operationId') AS updateId, json_extract(body,'$.buildId') AS buildId,
      MAX(json_extract(body,'$.count')) AS count FROM events WHERE kind='lifecycle' AND component='gateway' AND at>=? AND at<=?
      AND json_extract(body,'$.lifecycle')='deployment' AND json_extract(body,'$.operationId') IS NOT NULL
      AND json_extract(body,'$.count') IS NOT NULL GROUP BY updateId,buildId`).all(from,to);
  }
  connectionDowntime(from: number, to: number) {
    const rows = this.db.prepare('SELECT actor,started,observed,completed FROM connection_outages WHERE observed>=? AND started<=? ORDER BY actor,started').all(from,to);
    const days = new Map<string, { actor: string; day: string; intervals: number[][]; unfinished: number }>();
    for (const row of rows) {
      const start = Math.max(from,Number(row.started)), end = Math.min(to,Number(row.observed));
      for (let day = Math.floor(start/86400000); day <= Math.floor(end/86400000); day++) {
        const date = new Date(day*86400000).toISOString().slice(0,10), key = JSON.stringify([row.actor,date]);
        const value = days.get(key) ?? { actor: String(row.actor), day: date, intervals: [], unfinished: 0 };
        value.intervals.push([Math.max(start,day*86400000),Math.min(end,(day+1)*86400000)]);
        if (!row.completed) value.unfinished++;
        days.set(key,value);
      }
    }
    return [...days.values()].map(value => {
      let durationMs = 0, end = -Infinity;
      for (const interval of value.intervals.sort((a,b) => a[0]!-b[0]!)) {
        durationMs += Math.max(0,interval[1]!-Math.max(end,interval[0]!)); end = Math.max(end,interval[1]!);
      }
      return { actor: value.actor, day: value.day, seconds: durationMs/1000, unfinished: value.unfinished };
    });
  }
  executions(from: number, to: number) {
    return this.db.prepare('SELECT outcome,count(*) AS count FROM executions WHERE started<=? AND COALESCE(ended,?)>=? GROUP BY outcome').all(to,to,from);
  }
  progress(activeWindowMs = 1_800_000) {
    return this.db.prepare('SELECT engine,stage,count(*) AS count,MIN(progress_at) AS oldestProgressAt FROM execution_progress WHERE terminal=0 AND progress_at>=? GROUP BY engine,stage').all(this.now() - activeWindowMs);
  }
  queues() {
    return this.db.prepare('SELECT engine,sum(count) AS count,MIN(received) AS oldestCaptureAt FROM queue_samples WHERE received>=? AND observed_at>=? GROUP BY engine').all(this.now()-limits.freshnessMs,this.now()-limits.freshnessMs);
  }
  prune(maxAgeMs = 1_800_000) {
    this.db.prepare('UPDATE execution_progress SET terminal=1 WHERE terminal=0 AND progress_at<?').run(this.now() - maxAgeMs);
    const cutoff = this.now()-limits.retentionMs;
    this.db.prepare('DELETE FROM execution_progress WHERE received<?').run(cutoff);
    this.db.prepare('DELETE FROM queue_samples WHERE received<?').run(cutoff);
    this.db.prepare('DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE received<? ORDER BY received LIMIT 10000)').run(cutoff);
    this.db.prepare('DELETE FROM executions WHERE updated<?').run(cutoff);
    this.db.prepare('DELETE FROM producers WHERE received<?').run(cutoff);
    this.db.prepare('DELETE FROM activity_hours WHERE hour<?').run(Math.floor(cutoff/3600000));
    this.db.prepare('DELETE FROM recovery_episodes WHERE last_at<?').run(cutoff);
    this.db.prepare('DELETE FROM connection_outages WHERE observed<?').run(cutoff);
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }
  close() { this.db.close(); }
}
