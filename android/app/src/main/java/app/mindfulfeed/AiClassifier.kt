package app.mindfulfeed

import com.anthropic.client.AnthropicClient
import com.anthropic.client.okhttp.AnthropicOkHttpClient
import com.anthropic.core.JsonValue
import com.anthropic.errors.AnthropicIoException
import com.anthropic.errors.AnthropicServiceException
import com.anthropic.errors.PermissionDeniedException
import com.anthropic.errors.RateLimitException
import com.anthropic.errors.UnauthorizedException
import com.anthropic.models.beta.messages.BetaJsonOutputFormat
import com.anthropic.models.beta.messages.BetaOutputConfig
import com.anthropic.models.beta.messages.BetaStopReason
import com.anthropic.models.beta.messages.MessageCreateParams
import org.json.JSONArray
import org.json.JSONObject

/**
 * Optional AI pass: asks Claude to label a batch of video titles along the
 * same dimensions as the on-device keyword classifier (core/classifier.js).
 *
 * Only titles, channel names, durations and a short text snippet are sent.
 * The result is cached by the page (per video id), so each video is
 * classified at most once.
 */
class AiClassifier(apiKey: String) {

    private val client: AnthropicClient = AnthropicOkHttpClient.builder()
        .apiKey(apiKey)
        .build()

    class AiException(message: String) : Exception(message)

    /**
     * @param model     e.g. "claude-opus-5-5"
     * @param items     [{id,title,channel,duration,snippet}]
     * @param needs     allowed need labels (from the page, single source of truth)
     * @param topics    allowed topic labels
     * @return          [{id,needs,load,tone,political,news,distressing,parasocial,addictive,informational,topics,reason}]
     */
    fun classify(model: String, items: JSONArray, needs: List<String>, topics: List<String>): JSONArray {
        val builder = MessageCreateParams.builder()
            .model(model)
            .maxTokens(16000L)
            .system(SYSTEM_PROMPT)
            .addUserMessage(
                "Classify these YouTube videos. Return one result per id, in any order.\n\n" + items.toString(1)
            )
            .outputConfig(
                BetaOutputConfig.builder()
                    // Short, well-defined labelling task: low effort keeps it fast and cheap.
                    .effort(BetaOutputConfig.Effort.LOW)
                    .format(BetaJsonOutputFormat.builder().schema(schema(needs, topics)).build())
                    .build()
            )
        // Server-side refusal fallback (the Haiku tier has no server-side fallback).
        if (!model.contains("haiku")) {
            builder.addBeta(FALLBACK_BETA).fallbacksDefault()
        }

        val message = try {
            client.beta().messages().create(builder.build())
        } catch (e: UnauthorizedException) {
            throw AiException("The API key was rejected – check it under “Set API key”.")
        } catch (e: PermissionDeniedException) {
            throw AiException("This API key may not use $model.")
        } catch (e: RateLimitException) {
            throw AiException("Rate limited – will retry with the next batch.")
        } catch (e: AnthropicServiceException) {
            throw AiException("API error ${e.statusCode()}: ${e.message}")
        } catch (e: AnthropicIoException) {
            throw AiException("Network error: ${e.message}")
        }

        val stop = message.stopReason().orElse(null)
        if (stop == BetaStopReason.REFUSAL) throw AiException("The model declined to classify this batch.")
        if (stop == BetaStopReason.MAX_TOKENS) throw AiException("Response was cut off – batch too large.")

        val text = message.content()
            .mapNotNull { block -> block.text().orElse(null)?.text() }
            .joinToString("")
        val parsed = JSONObject(text).optJSONArray("results") ?: JSONArray()

        // Normalise to the shape core/classifier.js mergeAi() expects.
        val out = JSONArray()
        for (i in 0 until parsed.length()) {
            val r = parsed.optJSONObject(i) ?: continue
            r.put("load", when (r.optString("load")) { "relaxed" -> 0; "strenuous" -> 2; else -> 1 })
            out.put(r)
        }
        return out
    }

    private fun schema(needs: List<String>, topics: List<String>): BetaJsonOutputFormat.Schema {
        fun str() = mapOf("type" to "string")
        fun bool() = mapOf("type" to "boolean")
        fun enumArray(values: List<String>) = mapOf("type" to "array", "items" to mapOf("type" to "string", "enum" to values))
        val itemProps = linkedMapOf(
            "id" to str(),
            "needs" to enumArray(needs),
            "load" to mapOf("type" to "string", "enum" to listOf("relaxed", "medium", "strenuous")),
            "tone" to mapOf("type" to "string", "enum" to listOf("light", "neutral", "heavy")),
            "political" to bool(),
            "news" to bool(),
            "distressing" to bool(),
            "parasocial" to bool(),
            "addictive" to bool(),
            "informational" to bool(),
            "topics" to enumArray(topics),
            "reason" to str(),
        )
        val item = mapOf(
            "type" to "object",
            "additionalProperties" to false,
            "required" to itemProps.keys.toList(),
            "properties" to itemProps,
        )
        return BetaJsonOutputFormat.Schema.builder()
            .putAdditionalProperty("type", JsonValue.from("object"))
            .putAdditionalProperty("additionalProperties", JsonValue.from(false))
            .putAdditionalProperty("required", JsonValue.from(listOf("results")))
            .putAdditionalProperty(
                "properties",
                JsonValue.from(mapOf("results" to mapOf("type" to "array", "items" to item)))
            )
            .build()
    }

    companion object {
        const val FALLBACK_BETA = "server-side-fallback-2026-07-01"

        val SYSTEM_PROMPT = """
            You label YouTube videos for a feed filter whose purpose is to protect the viewer's mental health.
            The viewer picks what they need right now (e.g. relaxation, a laugh, light curiosity, focused learning)
            and how much mental capacity they have; your labels decide which videos fit. Judge from the title,
            channel, duration and snippet. When unsure, prefer the reading a typical viewer would have.

            Fields:
            - needs: which needs the video genuinely serves. relax = calming, low stimulation; laugh = humour, fun,
              light entertainment; curious = interesting and easy to follow; learn = substantial informational value;
              create = hands-on (recipes, DIY, workouts, tutorials); inspire = uplifting, motivating;
              comfort = cosy, wholesome, reassuring. Empty if none apply.
            - load: cognitive effort to watch. relaxed = can watch while tired; medium = needs some attention;
              strenuous = dense, long or emotionally demanding.
            - tone: light, neutral or heavy (heavy = conflict, outrage, fear, grief, bad news).
            - political: about politics, elections, politicians, geopolitics, culture-war topics.
            - news: current-events news coverage.
            - distressing: crime, violence, war, disasters, horror, graphic or disturbing material.
            - parasocial: mainly built on the viewer's relationship with a personality rather than on content:
              personal vlogs, life updates, drama, call-outs, reaction videos, stream VODs, "we need to talk".
            - addictive: engineered for compulsive watching: clickbait, rage bait, outrage framing, challenges,
              pranks, "wait for it", endless compilations.
            - informational: the main value is information or explanation.
            - topics: zero or more of the allowed topic labels.
            - reason: at most 12 words explaining the most important label.
        """.trimIndent()
    }
}
