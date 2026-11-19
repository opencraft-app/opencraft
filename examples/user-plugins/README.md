# User plugin example

This directory is an example of the trusted, deployment-owner-installed Web
plugin format. It is not enabled automatically. To try it, copy the directory
outside the release tree and set `OPENCRAFT_USER_PLUGIN_DIRECTORY` to that copy
for the managed Web worker. The deployment owner must trust the plugin code:
it runs with the privileges of a trusted extension.

`plugins.json` declares the `user.hello` plugin and its SHA-256 digest. Its
entry point lives under `public/user.hello/plugin.mjs`. It registers the
`user.hello.greet` command. If you change the entry point, update the `sha256`
in the index to match the new file; the server rejects mismatches rather than
loading altered code. Keep the installation outside release directories so a
release replacement does not erase it.
