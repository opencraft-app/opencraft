package com.vela.im

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder

/**
 * Vela identity service: exchanges the host app's login, manages this person's identities and signs a short-lived
 * UserSig. It never relays messages; [VelaNativeClient] logs the identity into Tencent IM directly.
 */
class VelaApi(baseUrl: String, var token: String = "") {
    val baseUrl = baseUrl.trimEnd('/')
    init {
        val uri = URI(this.baseUrl)
        require(uri.scheme == "https" || uri.scheme == "http" && uri.host in listOf("localhost", "127.0.0.1", "10.0.2.2")) { "Use HTTPS for a remote Vela API" }
    }

    suspend fun request(path: String, body: JSONObject? = null, method: String = if (body == null) "GET" else "POST"): Any? = withContext(Dispatchers.IO) {
        val connection = URL("$baseUrl/api$path").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method; connection.connectTimeout = 15000; connection.readTimeout = 30000
            connection.instanceFollowRedirects = false
            if (token.isNotEmpty()) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)?.bufferedReader()?.use { it.readText() } ?: "null"
            val value = org.json.JSONTokener(text).nextValue()
            if (status !in 200..299) throw VelaException(status, (value as? JSONObject)?.optString("error") ?: "IM request failed")
            if (value === JSONObject.NULL) null else value
        } finally { connection.disconnect() }
    }
    private fun path(id: String) = URLEncoder.encode(id, "UTF-8")

    suspend fun exchange(assertion: String) = request("/auth/exchange", JSONObject().put("assertion", assertion)) as JSONObject
    /** Demo only: every call creates an independent visitor identity. */
    suspend fun demoSession() = request("/auth/demo", JSONObject()) as JSONObject
    suspend fun me() = request("/me") as JSONObject
    suspend fun participants() = request("/demo/participants") as JSONObject
    suspend fun createIdentity(name: String, kind: String) = request("/identities", JSONObject().put("name", name).put("kind", kind)) as JSONObject
    suspend fun issueIdentityToken(id: String) = request("/identities/${path(id)}/tokens", JSONObject()) as JSONObject
    suspend fun revokeIdentityTokens(id: String) = request("/identities/${path(id)}/tokens", null, "DELETE")
    suspend fun credentials() = VelaCredentials.from(request("/credentials") as JSONObject)
    /** Owner session: who may send runtime commands (e.g. Hermes /new) to one of your identities. */
    suspend fun identitySettings(id: String) = request("/identities/${path(id)}/settings") as JSONObject
    suspend fun setCommandPolicy(id: String, policy: CommandPolicy) =
        request("/identities/${path(id)}/settings", JSONObject().put("commandPolicy", policy.value), "PUT") as JSONObject
    /** Identity session: this identity's command policy and its owner's identities. */
    suspend fun control() = request("/control") as JSONObject
    suspend fun logout() = request("/auth/logout", null, "DELETE")

    suspend fun getGroupReplyPolicy(groupId: String): GroupReplyPolicy =
        GroupReplyPolicy.from(request("/groups/${path(normalizeGroupId(groupId))}/reply-policy") as JSONObject)
    suspend fun setGroupReplyPolicy(groupId: String, mode: GroupReplyMode): GroupReplyPolicy =
        GroupReplyPolicy.from(request("/groups/${path(normalizeGroupId(groupId))}/reply-policy", JSONObject().put("mode", mode.value), "PUT") as JSONObject)
}

data class VelaCredentials(val sdkAppId: Int, val userId: String, val userSig: String, val expiresAt: Long) {
    companion object { fun from(value: JSONObject) = VelaCredentials(value.getInt("SDKAppID"), value.getString("userID"), value.getString("userSig"), value.getLong("expiresAt")) }
}
class VelaException(val code: Int, message: String) : Exception(message)
enum class CommandPolicy(val value: String) { OWNER("owner"), ANYONE("anyone") }

/** Tencent group IDs (@TGS#…) differ from conversation IDs (GROUP@TGS#…). */
fun normalizeGroupId(id: String) = if (id.startsWith("GROUP@TGS#")) id.removePrefix("GROUP") else id
