# LightVela Hermes extension

Trusted OpenCraft extension that signs in to LightVela, discovers running Bot
instances, reaches each Bot's loopback Hermes dashboard through Tencent TAT,
and presents the result as a normal OpenCraft AppServer Host.

The copied transport and protocol implementation is derived from the
`mychat` reference repository. The prototype page, global DOM wiring, and CSS
are intentionally not copied: OpenCraft owns application chrome and rendering.
