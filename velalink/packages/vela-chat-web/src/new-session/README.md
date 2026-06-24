# New Session

Reusable new-session setup surface for hosts that create a velad session.

This folder owns only presentation and form state shape. Hosts provide backend
catalog-derived options, working-directory defaults, and the submit handler.
It must not import Electron, Next routes, or the velad client directly.
