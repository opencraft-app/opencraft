export type UserMessageCollapseState = "uncollapsible" | "collapsed" | "expanded";

export interface UserMessageNaturalMeasurement {
  /** Identity of the content whose natural (unclipped) size was observed. */
  readonly contentIdentity: string;
  readonly contentHeight: number | null;
  readonly collapsedHeight: number | null;
}

export interface UserMessageNaturalMeasurementTransaction extends UserMessageNaturalMeasurement {
  readonly viewportWidth: number | null;
}

export interface UserMessageCollapseInput {
  readonly contentIdentity: string;
  readonly expandedContentIdentity: string | null;
  readonly measurement: UserMessageNaturalMeasurement | null;
  readonly tolerance?: number;
}

/**
 * Pure collapse policy shared by every presentation host.
 *
 * Platform observers own natural-size measurement. The policy rejects stale
 * measurements by identity and never reads rendered/clipped geometry itself.
 */
export function deriveUserMessageCollapseState({
  contentIdentity,
  expandedContentIdentity,
  measurement,
  tolerance = 1,
}: UserMessageCollapseInput): UserMessageCollapseState {
  if (
    measurement === null
    || measurement.contentIdentity !== contentIdentity
    || measurement.contentHeight === null
    || measurement.collapsedHeight === null
    || !Number.isFinite(measurement.contentHeight)
    || !Number.isFinite(measurement.collapsedHeight)
    || measurement.contentHeight <= measurement.collapsedHeight + tolerance
  ) {
    return "uncollapsible";
  }
  return expandedContentIdentity === contentIdentity ? "expanded" : "collapsed";
}

/** Expansion is content-owned: replacing the content implicitly collapses it. */
export function toggleUserMessageExpandedContentIdentity(
  contentIdentity: string,
  expandedContentIdentity: string | null,
): string | null {
  return expandedContentIdentity === contentIdentity ? null : contentIdentity;
}

const VIEWPORT_WIDTH_TOLERANCE = 0.5;

export function reconcileUserMessageNaturalMeasurement(
  measurement: UserMessageNaturalMeasurementTransaction | null,
  contentIdentity: string,
  collapsedHeight: number,
): UserMessageNaturalMeasurementTransaction {
  if (measurement?.contentIdentity !== contentIdentity) {
    return { contentIdentity, collapsedHeight, contentHeight: null, viewportWidth: null };
  }
  return measurement.collapsedHeight === collapsedHeight
    ? measurement
    : { ...measurement, collapsedHeight };
}

export function observeUserMessageViewportWidth(
  measurement: UserMessageNaturalMeasurementTransaction | null,
  contentIdentity: string,
  collapsedHeight: number,
  viewportWidth: number,
): UserMessageNaturalMeasurementTransaction {
  const owned = reconcileUserMessageNaturalMeasurement(measurement, contentIdentity, collapsedHeight);
  if (owned.viewportWidth === null) return { ...owned, viewportWidth };
  if (Math.abs(owned.viewportWidth - viewportWidth) <= VIEWPORT_WIDTH_TOLERANCE) return owned;
  return { contentIdentity, collapsedHeight, contentHeight: null, viewportWidth };
}

export function observeUserMessageNaturalHeight(
  measurement: UserMessageNaturalMeasurementTransaction | null,
  contentIdentity: string,
  collapsedHeight: number,
  contentHeight: number,
  transactionOpen: boolean,
): UserMessageNaturalMeasurementTransaction {
  const owned = reconcileUserMessageNaturalMeasurement(measurement, contentIdentity, collapsedHeight);
  if (
    !Number.isFinite(contentHeight)
    || contentHeight < 0
    || owned.contentHeight === contentHeight
  ) return owned;
  // A clipped RN container may still report its child's natural size after
  // async media layout. Growth beyond the previously accepted natural size is
  // trustworthy; a smaller clipped observation cannot prove shrinkage.
  if (!transactionOpen && (
    owned.contentHeight === null || contentHeight <= owned.contentHeight
  )) return owned;
  return { ...owned, contentHeight };
}
