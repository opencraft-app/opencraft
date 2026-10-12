package com.vela.im

import android.content.Context
import com.tencent.imsdk.v2.*
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A normal Tencent IM user. Human and Agent identities share the same rules; Tencent enforces permissions. */
class VelaNativeClient(private val context: Context) {
    val native: V2TIMManager get() = V2TIMManager.getInstance()
    val messages: V2TIMMessageManager get() = V2TIMManager.getMessageManager()
    val friendships: V2TIMFriendshipManager get() = V2TIMManager.getFriendshipManager()
    val groups: V2TIMGroupManager get() = V2TIMManager.getGroupManager()
    val conversations: V2TIMConversationManager get() = V2TIMManager.getConversationManager()
    private var sdkAppId: Int? = null
    val userId: String get() = native.loginUser.orEmpty()

    private suspend fun done(block: (V2TIMCallback) -> Unit) = suspendCancellableCoroutine<Unit> { continuation ->
        block(object : V2TIMCallback {
            override fun onSuccess() { if (continuation.isActive) continuation.resume(Unit) }
            override fun onError(code: Int, desc: String?) { if (continuation.isActive) continuation.resumeWithException(VelaException(code, desc ?: "IM operation failed")) }
        })
    }
    private suspend fun <T> value(block: (V2TIMValueCallback<T>) -> Unit) = suspendCancellableCoroutine<T> { continuation ->
        block(object : V2TIMValueCallback<T> {
            override fun onSuccess(result: T) { if (continuation.isActive) continuation.resume(result) }
            override fun onError(code: Int, desc: String?) { if (continuation.isActive) continuation.resumeWithException(VelaException(code, desc ?: "IM operation failed")) }
        })
    }

    suspend fun connect(credentials: VelaCredentials) {
        if (sdkAppId != credentials.sdkAppId) {
            if (sdkAppId != null) { disconnect(); native.unInitSDK() }
            check(native.initSDK(context.applicationContext, credentials.sdkAppId, V2TIMSDKConfig().apply { logLevel = V2TIMSDKConfig.V2TIM_LOG_NONE })) { "Tencent SDK initialization failed" }
            sdkAppId = credentials.sdkAppId
        }
        if (!native.loginUser.isNullOrEmpty()) disconnect()
        done { native.login(credentials.userId, credentials.userSig, it) }
    }
    suspend fun disconnect() = done { native.logout(it) }
    fun onMessage(listener: V2TIMAdvancedMsgListener): () -> Unit {
        messages.addAdvancedMsgListener(listener)
        return { messages.removeAdvancedMsgListener(listener) }
    }

    // ── Every message type ──
    fun text(content: String): V2TIMMessage = messages.createTextMessage(content)
    fun textAt(content: String, userIds: List<String>): V2TIMMessage = messages.createTextAtMessage(content, userIds)
    fun image(path: String): V2TIMMessage = messages.createImageMessage(path)
    fun audio(path: String, seconds: Int): V2TIMMessage = messages.createSoundMessage(path, seconds)
    fun video(path: String, type: String, seconds: Int, snapshotPath: String): V2TIMMessage = messages.createVideoMessage(path, type, seconds, snapshotPath)
    fun file(path: String, name: String): V2TIMMessage = messages.createFileMessage(path, name)
    fun location(description: String, latitude: Double, longitude: Double): V2TIMMessage = messages.createLocationMessage(description, latitude, longitude)
    fun face(index: Int, data: ByteArray): V2TIMMessage = messages.createFaceMessage(index, data)
    fun custom(data: ByteArray, description: String = "", extension: ByteArray = byteArrayOf()): V2TIMMessage = messages.createCustomMessage(data, description, extension)
    fun merger(list: List<V2TIMMessage>, title: String, abstracts: List<String>, compatibleText: String = "聊天记录"): V2TIMMessage = requireNotNull(messages.createMergerMessage(list, title, abstracts, compatibleText))
    fun forward(message: V2TIMMessage): V2TIMMessage = requireNotNull(messages.createForwardMessage(message))
    fun targetedGroup(message: V2TIMMessage, userIds: List<String>): V2TIMMessage = messages.createTargetedGroupMessage(message, userIds)
    fun atSignedGroup(message: V2TIMMessage, userIds: List<String>): V2TIMMessage = messages.createAtSignedGroupMessage(message, userIds)
    fun quote(message: V2TIMMessage, original: V2TIMMessage): V2TIMMessage = messages.createQuoteMessage(message, original)
    suspend fun send(message: V2TIMMessage, to: String, group: Boolean = false, cloudCustomData: String? = null, push: V2TIMOfflinePushInfo? = null, progress: (Int) -> Unit = {}): V2TIMMessage {
        if (cloudCustomData != null) message.cloudCustomData = cloudCustomData
        return suspendCancellableCoroutine { continuation ->
            messages.sendMessage(message, if (group) null else to, if (group) normalizeGroupId(to) else null, V2TIMMessage.V2TIM_PRIORITY_DEFAULT, false, push, object : V2TIMSendCallback<V2TIMMessage> {
                override fun onProgress(value: Int) = progress(value)
                override fun onSuccess(result: V2TIMMessage) { if (continuation.isActive) continuation.resume(result) }
                override fun onError(code: Int, desc: String?) { if (continuation.isActive) continuation.resumeWithException(VelaException(code, desc ?: "Send failed")) }
            })
        }
    }

    // ── Conversations and history ──
    suspend fun getConversations(): List<V2TIMConversation> = value<V2TIMConversationResult> { conversations.getConversationList(0, 100, it) }.conversationList
    /** Newest first, older than [before] when given. */
    suspend fun getHistory(peerOrGroupId: String, group: Boolean, count: Int = 20, before: V2TIMMessage? = null): List<V2TIMMessage> =
        if (group) value { messages.getGroupHistoryMessageList(normalizeGroupId(peerOrGroupId), count, before, it) }
        else value { messages.getC2CHistoryMessageList(peerOrGroupId, count, before, it) }
    suspend fun markRead(conversationId: String) = done { conversations.cleanConversationUnreadMessageCount(conversationId, 0, 0, it) }
    suspend fun revokeMessage(message: V2TIMMessage) = done { messages.revokeMessage(message, it) }

    // ── Friends: ordinary confirmation rules ──
    suspend fun getFriends(): List<V2TIMFriendInfo> = value { friendships.getFriendList(it) }
    suspend fun getFriendApplications(): List<V2TIMFriendApplication> = value<V2TIMFriendApplicationResult> { friendships.getFriendApplicationList(it) }.friendApplicationList
    suspend fun addFriend(userId: String, wording: String = "", remark: String = ""): V2TIMFriendOperationResult {
        val application = V2TIMFriendAddApplication(userId).apply {
            setAddWording(wording); setFriendRemark(remark); setAddSource("AddSource_Type_Vela"); setAddType(V2TIMFriendInfo.V2TIM_FRIEND_TYPE_BOTH)
        }
        return value { friendships.addFriend(application, it) }
    }
    private suspend fun application(userId: String) = getFriendApplications().firstOrNull { it.userID == userId && it.type == V2TIMFriendApplication.V2TIM_FRIEND_APPLICATION_COME_IN }
        ?: throw VelaException(404, "No pending friend request from $userId")
    suspend fun acceptFriend(userId: String): V2TIMFriendOperationResult {
        val request = application(userId)
        return value { friendships.acceptFriendApplication(request, V2TIMFriendApplication.V2TIM_FRIEND_ACCEPT_AGREE_AND_ADD, it) }
    }
    suspend fun refuseFriend(userId: String): V2TIMFriendOperationResult {
        val request = application(userId)
        return value { friendships.refuseFriendApplication(request, it) }
    }
    suspend fun deleteFriend(userId: String): List<V2TIMFriendOperationResult> = value { friendships.deleteFromFriendList(listOf(userId), V2TIMFriendInfo.V2TIM_FRIEND_TYPE_BOTH, it) }

    // ── Groups: Tencent checks owner/admin rights for every identity ──
    suspend fun getGroups(): List<V2TIMGroupInfo> = value { groups.getJoinedGroupList(it) }
    /** Returns the new group ID. Type is a Tencent group type: Public (default), Work, Meeting, Community. */
    suspend fun createGroup(name: String, memberIds: List<String> = emptyList(), type: String = V2TIMManager.GROUP_TYPE_PUBLIC): String {
        val info = V2TIMGroupInfo().apply { groupType = type; groupName = name }
        val members = memberIds.map { id -> V2TIMCreateGroupMemberInfo().apply { userID = id } }
        return value { groups.createGroup(info, members, it) }
    }
    suspend fun getGroupMembers(groupId: String): List<V2TIMGroupMemberFullInfo> {
        val all = mutableListOf<V2TIMGroupMemberFullInfo>(); var next = 0L
        do {
            val page = value<V2TIMGroupMemberInfoResult> { groups.getGroupMemberList(normalizeGroupId(groupId), V2TIMGroupMemberFullInfo.V2TIM_GROUP_MEMBER_FILTER_ALL, next, it) }
            all += page.memberInfoList; next = page.nextSeq
        } while (next != 0L)
        return all
    }
    suspend fun addGroupMembers(groupId: String, userIds: List<String>): List<V2TIMGroupMemberOperationResult> = value { groups.inviteUserToGroup(normalizeGroupId(groupId), userIds, it) }
    suspend fun removeGroupMembers(groupId: String, userIds: List<String>, reason: String = ""): List<V2TIMGroupMemberOperationResult> = value { groups.kickGroupMember(normalizeGroupId(groupId), userIds, reason, it) }
    suspend fun setGroupMemberRole(groupId: String, userId: String, admin: Boolean) = done {
        groups.setGroupMemberRole(normalizeGroupId(groupId), userId, if (admin) V2TIMGroupMemberFullInfo.V2TIM_GROUP_MEMBER_ROLE_ADMIN else V2TIMGroupMemberFullInfo.V2TIM_GROUP_MEMBER_ROLE_MEMBER, it)
    }
    suspend fun muteGroupMember(groupId: String, userId: String, seconds: Int) = done { groups.muteGroupMember(normalizeGroupId(groupId), userId, seconds, it) }
    suspend fun transferGroupOwner(groupId: String, userId: String) = done { groups.transferGroupOwner(normalizeGroupId(groupId), userId, it) }
    suspend fun quitGroup(groupId: String) = done { native.quitGroup(normalizeGroupId(groupId), it) }
    suspend fun dismissGroup(groupId: String) = done { native.dismissGroup(normalizeGroupId(groupId), it) }

    // ── Profiles ──
    suspend fun getUserProfiles(userIds: List<String>): List<V2TIMUserFullInfo> = value { native.getUsersInfo(userIds, it) }
    suspend fun updateMyProfile(nick: String? = null, faceUrl: String? = null) = done {
        native.setSelfInfo(V2TIMUserFullInfo().apply { nick?.let { setNickname(it) }; faceUrl?.let { setFaceUrl(it) } }, it)
    }

    // ── Vela group reply policy ──
    /** Decide whether this identity should answer [message], with up to [GroupReplyPolicy.contextMessages] preceding messages. */
    suspend fun prepareGroupReply(api: VelaApi, message: V2TIMMessage, maxAgentHops: Int = GroupReplies.DEFAULT_MAX_AGENT_HOPS): GroupReplyInput {
        require(maxAgentHops in 1..32) { "maxAgentHops must be 1..32" }
        val groupId = requireNotNull(message.groupID) { "Group message required" }
        val policy = api.getGroupReplyPolicy(groupId)
        val reason = GroupReplies.reason(message, userId, policy, maxAgentHops)
        var context = emptyList<V2TIMMessage>(); var status = "not_requested"
        if (reason == "accepted" && policy.contextMessages > 0) {
            val older = getHistory(groupId, true, policy.contextMessages * 2, message)
            context = older.filter { it.status != V2TIMMessage.V2TIM_MSG_STATUS_LOCAL_REVOKED && it.elemType != V2TIMMessage.V2TIM_ELEM_TYPE_GROUP_TIPS }
                .take(policy.contextMessages).reversed()
            status = if (context.size >= policy.contextMessages || older.size < policy.contextMessages * 2) "complete" else "partial"
        }
        return GroupReplyInput(message, policy, reason == "accepted", reason, context, status, Lineage.of(message))
    }
}
