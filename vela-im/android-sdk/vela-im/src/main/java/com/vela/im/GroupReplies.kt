package com.vela.im

import com.tencent.imsdk.v2.V2TIMMessage
import org.json.JSONObject

enum class GroupReplyMode(val value: String) {
    MENTION("mention"), MENTION_CONTEXT("mention_context"), ALL("all");
    companion object { fun from(value: String) = entries.first { it.value == value } }
}

data class GroupReplyPolicy(
    val groupId: String, val groupKind: String, val mode: GroupReplyMode,
    val effectiveMode: GroupReplyMode, val contextMessages: Int,
    val canManage: Boolean, val memberCount: Int, val updatedAt: Long
) {
    companion object {
        fun from(value: JSONObject) = GroupReplyPolicy(
            value.getString("groupID"), value.getString("groupKind"), GroupReplyMode.from(value.getString("mode")),
            GroupReplyMode.from(value.getString("effectiveMode")), value.getInt("contextMessages"),
            value.getBoolean("canManage"), value.getInt("memberCount"), value.getLong("updatedAt")
        )
    }
}

data class Lineage(val chainId: String, val hops: Int) {
    /** cloudCustomData for an automatic reply: same chain, one more hop. */
    fun reply(senderKind: String = "agent"): String =
        JSONObject().put("vela", JSONObject().put("chainId", chainId).put("hops", hops + 1).put("senderKind", senderKind)).toString()
    companion object {
        fun of(message: V2TIMMessage): Lineage = try {
            val vela = JSONObject(message.cloudCustomData ?: "{}").optJSONObject("vela") ?: JSONObject()
            Lineage(vela.optString("chainId").ifEmpty { message.msgID }, maxOf(0, vela.optInt("hops", 0)))
        } catch (_: Exception) { Lineage(message.msgID, 0) }
    }
}

/** Same rules as the JS/Python SDKs: own, revoked and system messages, hop limit, then the group's effective mode. */
data class GroupReplyInput(
    val message: V2TIMMessage, val policy: GroupReplyPolicy, val shouldReply: Boolean, val reason: String,
    val context: List<V2TIMMessage>, val contextStatus: String, val lineage: Lineage
)

object GroupReplies {
    private const val AT_ALL = "__kImSDK_MesssageAtALL__"

    fun reason(message: V2TIMMessage, userId: String, policy: GroupReplyPolicy, maxAgentHops: Int = 6): String = when {
        message.sender == userId -> "self"
        message.status == V2TIMMessage.V2TIM_MSG_STATUS_LOCAL_REVOKED -> "revoked"
        message.elemType == V2TIMMessage.V2TIM_ELEM_TYPE_GROUP_TIPS -> "system"
        Lineage.of(message).hops >= maxAgentHops -> "hop_limit"
        policy.effectiveMode != GroupReplyMode.ALL && !mentions(message, userId) -> "not_mentioned"
        else -> "accepted"
    }

    fun mentions(message: V2TIMMessage, userId: String): Boolean {
        val at = message.groupAtUserList ?: emptyList()
        return userId in at || AT_ALL in at || message.textElem?.text?.contains("@$userId") == true
    }
}
