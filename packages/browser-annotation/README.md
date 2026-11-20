# Browser annotation references

`BrowserAnnotation` retains the V1 primary `anchor` and `screenshot`. V2 adds
`schemaVersion: 2`, `selections`, `styleIntents`, `textReplacements`, and `evidence`.
The first selection must equal the primary anchor. Each selection has a unique,
immutable `id` and visible `label` (for example `1A`, `1C`). Removing a target does
not renumber survivors. `nextAnnotationSelectionLabel(number, issuedLabels)`
expects the transaction's complete label history, including deleted labels.
`upgradeAnnotation` migrates a V1 snapshot without page access or new capture.

`validateBrowserAnnotation(unknown)` returns a bounded data copy or `null`. It
rejects accessors, custom prototypes, cycles, pollution keys, unknown versions,
invalid coordinates and identities, duplicate labels, dangling selection links,
and unsupported or oversized images. Text selections and replacements preserve
exact Unicode, whitespace, and newlines; replacement `afterText: ""` means delete.
Do not turn historical binding keys into new page authority during restoration.

`annotationContextReference` validates before serializing. V1 keeps the generic
`inputImage` contract. V2 uses `inputImages: {url, preface?}[]` in image order, with
selection labels and IDs in each preface. Image bytes are stored once; the
`browserAnnotation.evidence` records retain associations and omit `dataUrl`.
`annotationFromReference` reconstructs those bytes by image order and rejects an
invalid V2 reference atomically. It retains the legacy behavior of dropping an
invalid V1 screenshot while keeping the readable annotation.

User comments, requested styles, and replacement after-text precede the untrusted
evidence boundary. Observed styles, before-text, page metadata, and image notes
remain quoted page evidence. Child-frame targets and regions do not advertise
main-frame browser tool refs. Display URLs omit credentials, query, and fragment;
these display URLs are not navigation or rebinding identities.
Malformed inputs have no display URL rather than reflecting an unparsed value.
The original stored anchor remains unchanged; restoration does not refresh it.

Limits: 8 targets and 4 images per annotation; 8 annotations, 32 targets, and
8 images per draft; 300 KiB per encoded image data URL; 2,000 UTF-16 code units per
selected/replacement text. `assertAnnotationDraftBudget(annotations)` validates
counts, identity uniqueness, and a 3 MiB UTF-8 serialized reference budget. The
Composer owner must also check the complete draft against its storage budget.
The generic Composer compiler independently validates images, preserves order,
checks model image support, and rejects overflow instead of dropping an image.
Supplying both `inputImages` and legacy `inputImage` is an error.
