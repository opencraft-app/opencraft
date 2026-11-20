// Phase-1 compatibility facade for existing tests/scripts. No business rules or SQL live here.
import { createLocalDomain } from "./runtime/create-local-domain.mjs";
export { digest, stable } from "./domain/values.mjs";
export class Store {
  constructor(profile) {
    const { app, uow } = createLocalDomain(profile);
    this.app = app;
    this.uow = uow;
    this.db = uow.db;
    this.profile = profile;
  }
  tx(fn) {
    return this.uow.transaction(fn);
  }
  close() {
    this.uow.close();
  }
  event(...a) {
    return this.app.event(...a);
  }
  events(...a) {
    return this.app.events(...a);
  }
  submit(...a) {
    return this.app.works.submit(...a);
  }
  amend(...a) {
    return this.app.works.amend(...a);
  }
  cancel(...a) {
    return this.app.works.cancel(...a);
  }
  cancelWork(...a) {
    return this.app.works.cancelWork(...a);
  }
  createWork(...a) {
    return this.app.works.create(...a);
  }
  work(id) {
    return this.app.r.works.get(id);
  }
  requireWork(id) {
    return this.app.works.require(id).record;
  }
  assertCurrent(...a) {
    return this.app.works.assertCurrent(...a);
  }
  pending() {
    return this.app.r.works.pending();
  }
  execution(...a) {
    return this.app.executions.execution(...a);
  }
  executionContext(...a) {
    return this.app.executions.snapshot(...a);
  }
  started(...a) {
    return this.app.executions.started(...a);
  }
  bound(...a) {
    return this.app.executions.bound(...a);
  }
  blocked(...a) {
    return this.app.executions.blocked(...a);
  }
  completedExecution(...a) {
    return this.app.outcomes.record(...a);
  }
  deliveries() {
    return this.app.outcomes.pending();
  }
  deliveryAccepted(...a) {
    return this.app.outcomes.accepted(...a);
  }
  deliveryFailed(...a) {
    return this.app.outcomes.failed(...a);
  }
  memoryCommand(...a) {
    return this.app.memory.change(...a);
  }
  memories() {
    return this.app.memory.list();
  }
  memoryEpoch() {
    return this.app.memory.epoch();
  }
  addRoutine(...a) {
    return this.app.routines.add(...a);
  }
  pauseRoutine(...a) {
    return this.app.routines.pause(...a);
  }
  stopRoutine(...a) {
    return this.app.routines.stop(...a);
  }
  tick(...a) {
    return this.app.routines.tick(...a);
  }
  status() {
    return this.app.status();
  }
  detail(...a) {
    return this.app.detail(...a);
  }
}
