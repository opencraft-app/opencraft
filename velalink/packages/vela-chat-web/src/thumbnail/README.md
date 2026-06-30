# Conversation Preview Surface

Reusable scaled React DOM previews for chat sessions.

This folder may import the shared chat render model and the reusable chat
surface from this package. It must not import Electron or desktop preload APIs.

The preview directly renders the shared `ChatSurface`, scaled with CSS
transforms. It must not rebuild turn rows, invent thumbnail-only message
layouts, or duplicate the conversation/composer surface. It is read-only and
intended for multiple hosts: floating desktop work monitors, overview pages,
session grids, and dashboards.
