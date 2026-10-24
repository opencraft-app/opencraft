
export function createImplementation(_ports) {
  return class {
    #lanes = new Map();
    #acknowledged = new Map();

    #key(owner, surface) { return JSON.stringify([owner, surface]); }
    #claim(host, state, reference, surface) {
      return { host, state, reference, surface, owner: host.getConversationId(),
        generation: state.mountGeneration };
    }
    #owns(claim) {
      return claim.host.getMountGeneration() === claim.generation
        && claim.host.getConversationId() === claim.owner;
    }
    #detach(claim) {
      if (this.#owns(claim)) claim.host.detach(claim.reference, claim.generation);
    }
    #clearWork(waiting) {
      ++waiting.epoch;
      if (waiting.frame !== null) window.cancelAnimationFrame(waiting.frame);
      if (waiting.timer !== null) window.clearTimeout(waiting.timer);
      waiting.frame = waiting.timer = null;
      waiting.started = false;
    }
    #unsubscribe(waiting) {
      const stop = waiting.unsubscribe;
      waiting.unsubscribe = null;
      stop?.();
    }
    #cancel(lane, keepFront) {
      const waiting = lane.waiting;
      if (!waiting) return;
      // Revoke the lease before calling ports, which may synchronously reenter.
      lane.waiting = null;
      this.#clearWork(waiting);
      this.#unsubscribe(waiting);
      this.#detach(waiting.claim);
      if (lane.front) {
        if (keepFront && this.#owns(lane.front)) {
          lane.front.host.clearStagedCoverBounds();
          lane.front.host.restoreInteraction();
        } else {
          this.#detach(lane.front);
          lane.front = null;
        }
      }
    }
    #valid(lane, waiting, epoch = waiting.epoch) {
      return lane.waiting === waiting && waiting.epoch === epoch
        && this.#owns(waiting.claim);
    }
    #position(lane, waiting) {
      if (lane.waiting !== waiting) return;
      const incoming = waiting.claim;
      if (incoming.host.getConversationId() !== incoming.owner) return;
      incoming.host.stage(incoming.state, incoming.reference);
      if (!this.#valid(lane, waiting)) return;
      lane.front.host.expandToCoverStagedBounds(incoming.state.bounds);
      incoming.host.placeImmediatelyBehind(lane.front.host);
      incoming.host.reveal(incoming.reference, true);
      incoming.host.placeImmediatelyBehind(lane.front.host);
    }
    #release(lane, waiting) {
      if (!this.#valid(lane, waiting)) return;
      const previous = lane.front;
      lane.waiting = null;
      lane.front = waiting.claim;
      this.#clearWork(waiting);
      this.#unsubscribe(waiting);
      if (previous) this.#detach(previous);
      // finishReveal owns focus, including the Host's separate automation lock.
      if (lane.front === waiting.claim && this.#owns(waiting.claim)) {
        waiting.claim.host.finishReveal();
      }
    }
    #prewarm(lane, waiting) {
      if (!this.#valid(lane, waiting) || waiting.started) return;
      waiting.started = true;
      const epoch = waiting.epoch;
      const frame = (step) => {
        waiting.frame = window.requestAnimationFrame(() => {
          if (!this.#valid(lane, waiting, epoch)) return;
          waiting.frame = null;
          if (step === 3) { this.#release(lane, waiting); return; }
          if (step === 2) {
            if (waiting.timer !== null) window.clearTimeout(waiting.timer);
            waiting.timer = null;
            const { host, reference } = waiting.claim;
            host.reveal(reference, true);
            if (!this.#valid(lane, waiting, epoch)) return;
          }
          frame(step + 1);
        });
      };
      frame(1);
    }
    #arm(lane, waiting) {
      const epoch = waiting.epoch;
      waiting.timer = window.setTimeout(() => {
        if (!this.#valid(lane, waiting, epoch)) return;
        waiting.timer = null;
        this.#prewarm(lane, waiting);
      }, 100);
      const ack = this.#acknowledged.get(waiting.claim.host);
      if (ack?.owner === waiting.claim.owner && ack.generation === waiting.claim.generation) {
        this.#acknowledged.delete(waiting.claim.host);
        this.#prewarm(lane, waiting);
      }
    }

    sync(host, state, reference, surface) {
      if (state.mountGeneration < host.getMountGeneration()) return;
      const claim = this.#claim(host, state, reference, surface);
      const key = this.#key(claim.owner, surface);
      // A Host has one presentation owner even when its surface changes.
      for (const [otherKey, other] of this.#lanes) {
        if (otherKey === key) continue;
        if (other.waiting?.claim.host === host) this.#cancel(other, true);
        if (other.front?.host === host) {
          if (other.waiting) this.#cancel(other, false);
          other.front = null;
        }
        if (!other.front && !other.waiting) this.#lanes.delete(otherKey);
      }
      let lane = this.#lanes.get(key);
      if (!lane) { lane = { front: null, waiting: null }; this.#lanes.set(key, lane); }
      if (!state.isVisible || !state.shouldPaint) {
        if (lane.waiting && (lane.front?.host === host || lane.waiting.claim.host === host)) {
          this.#cancel(lane, false);
        }
        if (lane.front?.host === host) lane.front = null;
        host.sync(state, reference);
        return;
      }
      if (lane.waiting?.claim.host === host) {
        const waiting = lane.waiting;
        const changedGeneration = waiting.claim.generation !== claim.generation;
        if (changedGeneration) this.#clearWork(waiting);
        waiting.claim = claim;
        this.#position(lane, waiting);
        if (changedGeneration) this.#arm(lane, waiting);
        return;
      }
      if (lane.waiting) this.#cancel(lane, true);
      if (!lane.front || lane.front.host === host || !lane.front.host.isPainted()) {
        const previous = lane.front;
        lane.front = claim;
        if (previous && previous.host !== host) this.#detach(previous);
        if (lane.front === claim && host.getConversationId() === claim.owner) host.sync(state, reference);
        return;
      }
      const waiting = { claim, frame: null, timer: null, epoch: 0,
        started: false, unsubscribe: null };
      lane.waiting = waiting;
      lane.front.host.blockInteraction();
      waiting.unsubscribe = host.listenForDidRegister(() => {
        if (this.#valid(lane, waiting)) host.placeImmediatelyBehind(lane.front.host);
      });
      this.#position(lane, waiting);
      if (this.#valid(lane, waiting)) this.#arm(lane, waiting);
    }

    detach(host, reference, surface, generation) {
      const lane = this.#lanes.get(this.#key(host.getConversationId(), surface));
      const matches = (claim) => claim?.host === host && claim.reference === reference
        && claim.generation === generation && this.#owns(claim);
      if (matches(lane?.waiting?.claim)) { this.#cancel(lane, false); return; }
      if (lane?.waiting && matches(lane.front)) {
        host.releaseRef(reference, generation);
        return;
      }
      // Stale refs/generations/surfaces cannot revoke a different current lease.
      if (matches(lane?.front)) {
        lane.front = null;
        host.detach(reference, generation);
      }
    }

    acknowledgeAttachment(host, acknowledgedGeneration, currentGeneration) {
      if (!host || acknowledgedGeneration !== currentGeneration) return;
      this.#acknowledged.set(host, {
        owner: host.getConversationId(), generation: acknowledgedGeneration,
      });
      for (const lane of this.#lanes.values()) {
        const waiting = lane.waiting;
        if (waiting?.claim.host === host && waiting.claim.generation === acknowledgedGeneration
          && this.#owns(waiting.claim)) {
          this.#acknowledged.delete(host);
          this.#prewarm(lane, waiting);
        }
      }
    }

    removeTab(host) {
      for (const [key, lane] of this.#lanes) {
        if (lane.waiting?.claim.host === host) this.#cancel(lane, false);
        else if (lane.front?.host === host && lane.waiting) {
          const waiting = lane.waiting;
          if (this.#valid(lane, waiting)) {
            waiting.claim.host.reveal(waiting.claim.reference, true);
            this.#release(lane, waiting);
          } else this.#cancel(lane, false);
        } else if (lane.front?.host === host) lane.front = null;
        if (!lane.front && !lane.waiting) this.#lanes.delete(key);
      }
      this.#acknowledged.delete(host);
    }
    #forgetHost(host) {
      for (const [key, lane] of this.#lanes) {
        if (lane.waiting && (lane.waiting.claim.host === host || lane.front?.host === host)) {
          this.#cancel(lane, false);
        }
        if (lane.front?.host === host) lane.front = null;
        if (!lane.front && !lane.waiting) this.#lanes.delete(key);
      }
      this.#acknowledged.delete(host);
    }
    transferRoute(host) { this.#forgetHost(host); }
    disposeHost(host) { this.#forgetHost(host); }
    removeConversation(owner) {
      for (const [host, ack] of this.#acknowledged) {
        if (ack.owner === owner) this.#acknowledged.delete(host);
      }
      for (const [key, lane] of this.#lanes) {
        if (lane.front?.owner !== owner && lane.waiting?.claim.owner !== owner) continue;
        if (lane.front) this.#acknowledged.delete(lane.front.host);
        if (lane.waiting) this.#acknowledged.delete(lane.waiting.claim.host);
        this.#cancel(lane, false);
        this.#lanes.delete(key);
      }
    }
    disposeAll() {
      for (const lane of this.#lanes.values()) this.#cancel(lane, false);
      this.#lanes.clear();
      this.#acknowledged = new Map();
    }
  };
}
