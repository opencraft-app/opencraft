# Companion avatars

Bot avatars use original vector artwork from packages/design-system/src/companion-artwork.ts.
Web/Electron render it through the shared CompanionAvatar component. Geometry and
versioned identity selection are independent of the renderer and theme.

Version 1 contains bean, sprout, bun, lamp, cloud and star; palettes are peach,
sage, honey, lilac, sky and rose. Shape and palette derive from separate salted
hashes of the stable Actor ID. Never randomize during render, use a display name
as identity, or change the v1 pool order. Future custom identities must retain an
explicit version and preserve prior assignments.

The 80×80 viewBox uses rounded silhouettes, two eyes, a small smile and subtle
cheeks. Small 24–32px use does not require text or decorative details. Each palette
owns surface/body/ink roles in both themes. Colour does not imply status, rights
or online presence. Duplicate visual combinations are expected and are not an
identity proof; always pair members with their name in directory rows.

Standalone avatars have an accessible label; avatars beside names and stacked
navigation previews are decorative. SVG has no external references, scripts or
IDs that could collide in a list. Human directory entries currently fall back to
the first character of the display name; this change does not invent an identity
provider or publish authentication bindings to obtain profile pictures.
