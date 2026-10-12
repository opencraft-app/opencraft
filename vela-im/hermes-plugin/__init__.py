"""Import-light Hermes platform plugin, with eagerly registered outbound tools."""
def register(ctx):
    from .adapter import register_platform
    register_platform(ctx)
    # 老版本 Hermes 没有 provides_tools eager loader，兼容性通过 ctx 中标记去重。
    from .tools import register_tools
    register_tools(ctx)
