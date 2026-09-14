// Source class body copied from ref/codex/browser/internal/is-different-host-in-conversation.js.
// Changes are limited to dependency injection and eager class export.
export function createImplementation(ports) {
const {createLoggerFacade,logger__Kp_mubr}=ports;
const handoffTimeoutMs=100, prewarmFrameCount=2, panelKinds=["right-panel","bottom-panel"];
function isDifferentHostInConversation(e, t) {
    return e.host !== t.host && e.host.getConversationId() === t.host.getConversationId() && e.host.isPainted();
}
function extractTabHandoffData(e) {
    return {
        incomingBrowserTabId: e.incoming.host.getBrowserTabId(),
        incomingConversationId: e.incoming.host.getConversationId(),
        incomingMountGeneration: e.incoming.mountGeneration,
        outgoingBrowserTabId: e.outgoing.host.getBrowserTabId(),
        outgoingConversationId: e.outgoing.host.getConversationId(),
        outgoingMountGeneration: e.outgoing.mountGeneration
    };
}
function filterHiddenBrowserUse(inputValue__e_2fjfg) {
    if (inputValue__e_2fjfg === `hidden-browser-use`) {
        return null;
    }
    return inputValue__e_2fjfg;
}
return class {
        paintedWebviews = {
            "bottom-panel": null,
            "right-panel": null
        };
        pendingHandoffs = {
            "bottom-panel": null,
            "right-panel": null
        };
        acknowledgedMountGenerations = new WeakMap;
        sync(conversationId__e_2fjnq, t, n, r) {
            let i = {
                host: conversationId__e_2fjnq,
                mountGeneration: t.mountGeneration ?? conversationId__e_2fjnq.getMountGeneration(),
                webviewRef: n
            };
            let a = filterHiddenBrowserUse(r);
            if (a == null || !t.isVisible || t.bounds == null || t.shouldBootstrap === true || t.shouldPaint === false) {
                if (a != null) {
                    this.clearAcknowledgements(conversationId__e_2fjnq, i.mountGeneration);
                    let t = this.pendingHandoffs[a];
                    if (t?.incoming.host === conversationId__e_2fjnq || t?.outgoing.host === conversationId__e_2fjnq) {
                        this.cancel(a, `incoming-hidden`, true);
                    }
                }
                conversationId__e_2fjnq.sync(t, n);
                if (a != null && this.paintedWebviews[a]?.host === conversationId__e_2fjnq && !conversationId__e_2fjnq.isPainted()) {
                    this.paintedWebviews[a] = null;
                }
                return;
            }
            let o = this.pendingHandoffs[a];
            if (o != null) {
                if (o.incoming.host === conversationId__e_2fjnq) {
                    o.incoming = i;
                    if (o.releaseFrameId == null) {
                        this.stageIncomingBehindOutgoing(o, t);
                    } else {
                        conversationId__e_2fjnq.sync(t, n);
                        this.paintedWebviews[a] = i;
                    }
                    return;
                }
                if (o.releaseFrameId != null) {
                    window.cancelAnimationFrame(o.releaseFrameId);
                    this.releaseOutgoing(a, o, `incoming-replaced`);
                } else {
                    let { outgoing: pendingHandoff__r_2fk9t } = o;
                    this.cancel(a, `incoming-replaced`, false);
                    if (pendingHandoff__r_2fk9t.host === conversationId__e_2fjnq) {
                        conversationId__e_2fjnq.sync(t, n);
                        this.paintedWebviews[a] = i;
                        return;
                    }
                    if (isDifferentHostInConversation(pendingHandoff__r_2fk9t, i)) {
                        this.stage(a, pendingHandoff__r_2fk9t, i, t);
                        return;
                    }
                }
            }
            let paintedWebview = this.paintedWebviews[a];
            if (paintedWebview != null && isDifferentHostInConversation(paintedWebview, i)) {
                this.stage(a, paintedWebview, i, t);
                return;
            }
            conversationId__e_2fjnq.sync(t, n);
            this.paintedWebviews[a] = conversationId__e_2fjnq.isPainted() ? i : null;
        }
        detach(host__e_2fkht, t, n, r) {
            let i = filterHiddenBrowserUse(n);
            if (i != null) {
                let incomingMountGeneration = this.pendingHandoffs[i];
                if (incomingMountGeneration?.outgoing.host === host__e_2fkht) {
                    host__e_2fkht.releaseRef(t, r);
                    return;
                }
                if (incomingMountGeneration?.incoming.host === host__e_2fkht) {
                    this.cancel(i, `incoming-detached`, true);
                    return;
                }
                if (this.paintedWebviews[i]?.host === host__e_2fkht) {
                    this.paintedWebviews[i] = null;
                }
            }
            host__e_2fkht.detach(t, r);
        }
        acknowledgeAttachment(e, t, n) {
            if (e == null || n !== t) {
                return;
            }
            for (let hostKind__r_2fkqv of panelKinds){
                let pendingHandoff__i_2fkr9 = this.pendingHandoffs[hostKind__r_2fkqv];
                if (pendingHandoff__i_2fkr9?.incoming.host === e && pendingHandoff__i_2fkr9.incoming.mountGeneration === t && n === t) {
                    logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer acknowledged Owl webview handoff`, {
                        safe: {
                            ...extractTabHandoffData(pendingHandoff__i_2fkr9),
                            acknowledgedMountGeneration: t,
                            currentMountGeneration: n,
                            hostKind: hostKind__r_2fkqv
                        },
                        sensitive: {}
                    });
                    this.scheduleCommitAfterPrewarm(hostKind__r_2fkqv, pendingHandoff__i_2fkr9);
                    return;
                }
                if (pendingHandoff__i_2fkr9 != null) {
                    logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer ignored stale Owl webview handoff acknowledgement`, {
                        safe: {
                            ...extractTabHandoffData(pendingHandoff__i_2fkr9),
                            acknowledgedMountGeneration: t,
                            currentMountGeneration: n,
                            hostKind: hostKind__r_2fkqv
                        },
                        sensitive: {}
                    });
                }
            }
            let r = this.acknowledgedMountGenerations.get(e);
            r ?? (r = new Set, this.acknowledgedMountGenerations.set(e, r));
            r.add(t);
        }
        removeTab(browserTabId__e_2fl8b) {
            this.clearAcknowledgements(browserTabId__e_2fl8b);
            for (let t of panelKinds){
                let n = this.pendingHandoffs[t];
                if (n?.outgoing.host === browserTabId__e_2fl8b) {
                    this.commit(t, n);
                    if (n.releaseFrameId != null) {
                        window.cancelAnimationFrame(n.releaseFrameId);
                        n.releaseFrameId = null;
                    }
                    this.releaseOutgoing(t, n, `tab-removed`);
                    continue;
                }
                if (n?.incoming.host === browserTabId__e_2fl8b) {
                    this.cancel(t, `tab-removed`, true);
                    continue;
                }
                let r = this.paintedWebviews[t];
                if (r?.host === browserTabId__e_2fl8b) {
                    this.paintedWebviews[t] = null;
                    browserTabId__e_2fl8b.detach(r.webviewRef, r.mountGeneration);
                }
            }
        }
        transferRoute(webview__e_2fll5) {
            for (let t of panelKinds){
                let n = this.pendingHandoffs[t];
                if (n?.incoming.host === webview__e_2fll5 || n?.outgoing.host === webview__e_2fll5) {
                    this.cancel(t, `route-transferred`, true);
                }
            }
        }
        removeConversation(viewportSize__e_2flpg) {
            for (let t of panelKinds){
                let n = this.pendingHandoffs[t];
                if (n?.incoming.host.getConversationId() === viewportSize__e_2flpg || n?.outgoing.host.getConversationId() === viewportSize__e_2flpg) {
                    this.cancel(t, `conversation-removed`, true);
                }
                if (this.paintedWebviews[t]?.host.getConversationId() === viewportSize__e_2flpg) {
                    this.paintedWebviews[t] = null;
                }
            }
        }
        disposeHost(surfaceSize) {
            this.clearAcknowledgements(surfaceSize);
            for (let t of panelKinds){
                let n = this.pendingHandoffs[t];
                if (n?.incoming.host === surfaceSize || n?.outgoing.host === surfaceSize) {
                    this.cancel(t, `host-disposed`, true);
                }
                if (this.paintedWebviews[t]?.host === surfaceSize) {
                    this.paintedWebviews[t] = null;
                }
            }
        }
        disposeAll() {
            for (let e of panelKinds){
                this.cancel(e, `manager-disposed`, true);
                let t = this.paintedWebviews[e];
                if (t != null) {
                    this.clearAcknowledgements(t.host);
                }
                this.paintedWebviews[e] = null;
            }
        }
        stage(e, t, n, r) {
            t.host.blockInteraction();
            let i = {
                incoming: n,
                outgoing: t,
                prewarmFrameId: null,
                releaseFrameId: null,
                removeIncomingDidRegisterListener: null,
                timeoutId: null
            };
            this.pendingHandoffs[e] = i;
            i.removeIncomingDidRegisterListener = n.host.listenForDidRegister(()=>{
                if (this.pendingHandoffs[e] === i) {
                    logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer observed Owl webview registration during handoff`, {
                        safe: {
                            ...extractTabHandoffData(i),
                            hostKind: e
                        },
                        sensitive: {}
                    });
                    i.incoming.host.placeImmediatelyBehind(i.outgoing.host);
                }
            });
            i.timeoutId = window.setTimeout(()=>{
                if (this.pendingHandoffs[e] === i) {
                    logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer timed out Owl webview handoff`, {
                        safe: {
                            ...extractTabHandoffData(i),
                            hostKind: e
                        },
                        sensitive: {}
                    });
                    i.timeoutId = null;
                    this.scheduleCommitAfterPrewarm(e, i);
                }
            }, handoffTimeoutMs);
            logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer staged Owl webview handoff`, {
                safe: {
                    ...extractTabHandoffData(i),
                    hostKind: e
                },
                sensitive: {}
            });
            this.stageIncomingBehindOutgoing(i, r);
            if (this.consumeAcknowledgement(n.host, n.mountGeneration)) {
                this.scheduleCommitAfterPrewarm(e, i);
            }
        }
        stageIncomingBehindOutgoing(e, t) {
            e.incoming.host.stage(t, e.incoming.webviewRef);
            e.outgoing.host.expandToCoverStagedBounds(t.bounds, t.scale, t.windowZoom);
            e.incoming.host.placeImmediatelyBehind(e.outgoing.host);
            e.incoming.host.reveal(e.incoming.webviewRef, true);
            e.incoming.host.placeImmediatelyBehind(e.outgoing.host);
        }
        scheduleCommitAfterPrewarm(e, t, n = prewarmFrameCount) {
            if (!(this.pendingHandoffs[e] !== t || t.prewarmFrameId != null || t.releaseFrameId != null)) {
                if (n === 0) {
                    logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer prewarmed Owl webview handoff before reveal`, {
                        safe: {
                            ...extractTabHandoffData(t),
                            hostKind: e
                        },
                        sensitive: {}
                    });
                    this.commit(e, t);
                    return;
                }
                logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer prewarming Owl webview handoff before reveal`, {
                    safe: {
                        ...extractTabHandoffData(t),
                        hostKind: e,
                        remainingFrames: n
                    },
                    sensitive: {}
                });
                t.prewarmFrameId = window.requestAnimationFrame(()=>{
                    if (this.pendingHandoffs[e] === t) {
                        t.prewarmFrameId = null;
                        this.scheduleCommitAfterPrewarm(e, t, n - 1);
                    }
                });
            }
        }
        commit(e, t) {
            if (!(this.pendingHandoffs[e] !== t || t.releaseFrameId != null)) {
                if (t.timeoutId != null) {
                    window.clearTimeout(t.timeoutId);
                    t.timeoutId = null;
                }
                if (t.prewarmFrameId != null) {
                    window.cancelAnimationFrame(t.prewarmFrameId);
                    t.prewarmFrameId = null;
                }
                t.incoming.host.reveal(t.incoming.webviewRef, true);
                this.paintedWebviews[e] = t.incoming;
                logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer committed Owl webview handoff`, {
                    safe: {
                        ...extractTabHandoffData(t),
                        hostKind: e
                    },
                    sensitive: {}
                });
                t.releaseFrameId = window.requestAnimationFrame(()=>{
                    this.releaseOutgoing(e, t, `next-animation-frame`);
                });
            }
        }
        releaseOutgoing(e, t, timing) {
            if (this.pendingHandoffs[e] === t) {
                this.pendingHandoffs[e] = null;
                t.removeIncomingDidRegisterListener?.();
                t.removeIncomingDidRegisterListener = null;
                t.outgoing.host.detach(t.outgoing.webviewRef, t.outgoing.mountGeneration);
                t.incoming.host.finishReveal();
                logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer released outgoing Owl webview handoff`, {
                    safe: {
                        ...extractTabHandoffData(t),
                        hostKind: e,
                        timing
                    },
                    sensitive: {}
                });
            }
        }
        cancel(e, reason, n) {
            let r = this.pendingHandoffs[e];
            if (r != null) {
                this.pendingHandoffs[e] = null;
                if (r.timeoutId != null) {
                    window.clearTimeout(r.timeoutId);
                }
                if (r.prewarmFrameId != null) {
                    window.cancelAnimationFrame(r.prewarmFrameId);
                }
                if (r.releaseFrameId != null) {
                    window.cancelAnimationFrame(r.releaseFrameId);
                }
                r.removeIncomingDidRegisterListener?.();
                this.clearAcknowledgements(r.incoming.host);
                r.incoming.host.detach(r.incoming.webviewRef, r.incoming.mountGeneration);
                if (n) {
                    r.outgoing.host.detach(r.outgoing.webviewRef, r.outgoing.mountGeneration);
                    this.paintedWebviews[e] = null;
                } else if (r.outgoing.host.isConnected()) {
                    r.outgoing.host.clearStagedCoverBounds();
                    r.outgoing.host.restoreInteraction();
                    this.paintedWebviews[e] = r.outgoing;
                } else {
                    this.paintedWebviews[e] = null;
                }
                logger__Kp_mubr.info(`IAB_TAB_SWITCH renderer cancelled Owl webview handoff`, {
                    safe: {
                        ...extractTabHandoffData(r),
                        detachOutgoing: n,
                        hostKind: e,
                        reason
                    },
                    sensitive: {}
                });
            }
        }
        consumeAcknowledgement(e, t) {
            let n = this.acknowledgedMountGenerations.get(e);
            if (n?.delete(t) === true) {
                if (n.size === 0) {
                    this.acknowledgedMountGenerations.delete(e);
                }
                return true;
            }
            return false;
        }
        clearAcknowledgements(e, t) {
            if (t == null) {
                this.acknowledgedMountGenerations.delete(e);
                return;
            }
            let n = this.acknowledgedMountGenerations.get(e);
            if (n != null) {
                for (let e of n){
                    if (e !== t) {
                        n.delete(e);
                    }
                }
                if (n.size === 0) {
                    this.acknowledgedMountGenerations.delete(e);
                }
            }
        }
    };
}
