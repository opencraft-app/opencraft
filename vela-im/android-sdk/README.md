# Vela Android SDK

Kotlin Android Library。`VelaApi` 对接 Vela 身份服务（外层登录兑换、身份、短期 UserSig、群回复规则），`VelaNativeClient` 用腾讯原生 IM SDK（`imsdk-plus` 9.1.7818）以该身份直连腾讯，并提供与 JS / Python SDK 对应的高层方法。外层宿主移交登录 JWT，不出现第二次登录页面。

在 Android Studio 打开此目录（JDK 17、Android SDK 35、Gradle 8.11.1），构建 `:vela-im:assembleRelease` 得到 AAR；或把 `vela-im` 模块加入宿主工程。

```kotlin
val owner = VelaApi("https://你的Vela服务")
val session = owner.exchange(outerLoginJWT)          // demo: owner.demoSession()
owner.token = session.getString("token")
val identity = session.getJSONArray("identities").getJSONObject(0)
val api = VelaApi(owner.baseUrl, owner.issueIdentityToken(identity.getString("id")).getString("token"))

val im = VelaNativeClient(applicationContext)
im.connect(api.credentials())
im.onMessage(object : V2TIMAdvancedMsgListener() {
    override fun onRecvNewMessage(message: V2TIMMessage) { /* 渲染完整原生消息 */ }
})
im.send(im.text("你好"), agentUserId)
im.addFriend(peerId, wording = "交个朋友")
val groupId = im.createGroup("共同空间", listOf(peerId, agentUserId))
im.removeGroupMembers(groupId, listOf(agentUserId))
```

高层方法：消息工厂 `text`、`textAt`、`image`、`audio`、`video`、`file`、`location`、`face`、`custom`、`merger`、`forward` 与 `send`；`getConversations`、`getHistory`、`markRead`、`revokeMessage`；`getFriends`、`getFriendApplications`、`addFriend`、`acceptFriend`、`refuseFriend`、`deleteFriend`；`getGroups`、`createGroup`、`getGroupMembers`、`addGroupMembers`、`removeGroupMembers`、`setGroupMemberRole`、`muteGroupMember`、`transferGroupOwner`、`quitGroup`、`dismissGroup`；`getUserProfiles`、`updateMyProfile`。`native`、`messages`、`friendships`、`groups`、`conversations` 仍暴露完整腾讯原生接口。

UserSig 有效期 2 小时，到期前由宿主再次调用 `api.credentials()` 并 `connect`。应用密钥只在服务端。

## 群回复规则

```kotlin
val policy = api.getGroupReplyPolicy(groupId)
if (policy.canManage) api.setGroupReplyPolicy(groupId, GroupReplyMode.MENTION_CONTEXT)

// 宿主运行 Agent 时：对收到的群消息做与 JS/Python 相同的判断，并取此前最多 10 条消息
val input = im.prepareGroupReply(api, message, maxAgentHops = 6)
if (input.shouldReply) {
    val answer = runYourAgent(input.message, input.context)
    im.send(im.text(answer), groupId, group = true, cloudCustomData = input.lineage.reply())
}
```

本机没有 Android SDK / Gradle，此模块未经编译验证，以源码模块交付。参考：[Android 集成](https://cloud.tencent.com/document/product/269/75283)。
