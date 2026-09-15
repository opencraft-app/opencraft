# LightVela Agent Core

Renderer- and transport-neutral Bot identity, lifecycle, catalog projection,
creation planning and application policy shared by LightVela surfaces. mono2 Web is the first consumer;
OpenCraft and native adapters may consume an interface only after its mono2 Web
behavior has been characterized.

This package must not import React, routing, i18n, browser globals, storage,
networking, analytics or product UI. Adapters own those capabilities.

Within an account/environment catalog, identity is the length-delimited tuple
`instanceId + botId + profileId`; repeated Profile-shaped Bot IDs on different
instances remain distinct. A future cross-environment consumer must add its
environment/account scope rather than weakening this tuple.

Creation planning distinguishes a first physical instance from an additional
Bot hosted by the first Running instance. It also resolves UI clone selections
into explicit blank or clone intent. HTTP endpoints, request bodies and user
messages remain adapter responsibilities.
