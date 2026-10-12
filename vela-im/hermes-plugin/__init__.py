"""Import-light Hermes platform plugin. Agents use the `vela_im` command line instead of model tools."""
def register(ctx):
    from .adapter import register_platform
    from .runtime import install_cli
    register_platform(ctx)
    install_cli()
