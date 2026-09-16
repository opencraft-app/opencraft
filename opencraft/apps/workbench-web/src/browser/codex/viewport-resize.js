// Source function bodies from ref/codex/lazy/app-initial/is-adjacent-tab-index.js.
import { clampPanelWidth__rBr_2f54e, getDefaultPanelWidth, initializeBrowserViewportPresets } from './viewport-presets.js';
initializeBrowserViewportPresets();
export function computeDragResizeDimensions({ drag: drag__e_2f4iq, fitHeight: fitHeight__t_2f4j2, fitWidth: fitWidth__n_2f4jd, pointerX: pointerX__r_2f4jo, pointerY: pointerY__i_2f4jz, scale: scale__a_2f4k7 }) {
    let o = drag__e_2f4iq.edge === `bottom` || drag__e_2f4iq.edge === `bottom-left` || drag__e_2f4iq.edge === `bottom-right`;
    let s = drag__e_2f4iq.edge !== `bottom`;
    let c = drag__e_2f4iq.edge === `left` || drag__e_2f4iq.edge === `bottom-left` ? -1 : 1;
    return {
        width: s ? clampPanelWidth__rBr_2f54e(computeConstrainedSize({
            fitSize: fitWidth__n_2f4jd,
            rawSize: drag__e_2f4iq.startWidth + (pointerX__r_2f4jo - drag__e_2f4iq.startPointerX) * c * 2 / scale__a_2f4k7,
            scale: scale__a_2f4k7
        })) : drag__e_2f4iq.startWidth,
        height: o ? getDefaultPanelWidth(computeConstrainedSize({
            fitSize: fitHeight__t_2f4j2,
            rawSize: drag__e_2f4iq.startHeight + (pointerY__i_2f4jz - drag__e_2f4iq.startPointerY) / scale__a_2f4k7,
            scale: scale__a_2f4k7
        })) : drag__e_2f4iq.startHeight
    };
}
function computeConstrainedSize({ fitSize, rawSize, scale: scale__n_2f51s }) {
    if (fitSize <= 0) {
        return rawSize;
    }
    return Math.min(rawSize, fitSize / scale__n_2f51s);
}
