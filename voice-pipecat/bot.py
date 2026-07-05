"""
Agente de voz UA Postgrados — Pipecat (self-hosted).  PoC / esqueleto.

Pipeline: Twilio (Media Streams) -> Deepgram STT (es) -> Claude (Anthropic) -> Azure TTS (es-CL)
con Silero VAD + barge-in. Las herramientas (catalogo/CRM) se ejecutan llamando a NUESTRO
backend Node (/voice/tool); al colgar se registra la llamada en Bitrix (/voice/call/finish).

NOTA DE VERSION: la API de Pipecat esta en transicion. Este esqueleto usa el patron clasico
(Pipeline/PipelineTask/PipelineRunner + OpenAILLMContext + create_context_aggregator). Fija una
version de pipecat-ai (requirements.txt) y ajusta imports si usas la variante nueva
(PipelineWorker/WorkerRunner, LLMContext). Docs: https://docs.pipecat.ai
"""

import os
import time

import aiohttp
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.pipeline.runner import PipelineRunner
from pipecat.frames.frames import LLMRunFrame
from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketTransport,
    FastAPIWebsocketParams,
)
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.transcriptions.language import Language
from pipecat.services.anthropic.llm import AnthropicLLMService
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair, LLMUserAggregatorParams
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.services.llm_service import FunctionCallParams

BACKEND_BASE = os.getenv("BACKEND_BASE", "").rstrip("/")  # ej. https://botbitrix24-production.up.railway.app
VOICE_SECRET = os.getenv("VOICE_SECRET", "")

SYSTEM_PROMPT = (
    "Asistente de voz de Postgrados, Universidad Autónoma de Chile. Español de Chile, cálido y profesional; no uses jerga. "
    "Saluda al comenzar la llamada. Respuestas de 1–2 frases, una pregunta a la vez, sin URLs ni listas. "
    "Usa 'consultar_programas' y 'detalle_programa' para datos de programas/precios; nunca inventes nombres, "
    "aranceles ni fechas. Pide en orden: nombre, luego correo, luego teléfono, y guárdalos con "
    "'registrar_interes_crm' apenas los tengas. Si piden un asesor o hay interés alto, usa 'transferir_a_asesor'. "
    "Al terminar, despídete corto."
)


def _tools() -> ToolsSchema:
    return ToolsSchema(
        standard_tools=[
            FunctionSchema(
                name="consultar_programas",
                description="Consulta el catálogo (magísteres, diplomados, especialidades).",
                properties={
                    "tipo": {"type": "string", "enum": ["magister", "diplomado", "especialidad"]},
                    "facultad": {"type": "string"},
                    "modalidad": {"type": "string"},
                    "texto": {"type": "string"},
                },
                required=[],
            ),
            FunctionSchema(
                name="detalle_programa",
                description="Arancel, matrícula, requisitos y descripción de UN programa. Pasa nombre o url.",
                properties={"nombre": {"type": "string"}, "url": {"type": "string"}},
                required=[],
            ),
            FunctionSchema(
                name="registrar_interes_crm",
                description="Guarda en el CRM nombre/apellido/email/teléfono y programa de interés.",
                properties={
                    "nombre": {"type": "string"},
                    "apellido": {"type": "string"},
                    "email": {"type": "string"},
                    "telefono": {"type": "string"},
                    "programa_interes": {"type": "string"},
                    "comentario": {"type": "string"},
                },
                required=[],
            ),
            FunctionSchema(
                name="transferir_a_asesor",
                description="Deriva la llamada a un asesor humano.",
                properties={"motivo": {"type": "string"}},
                required=["motivo"],
            ),
        ]
    )


async def _call_backend_tool(name: str, args: dict, call_id: str, phone: str) -> dict:
    """Ejecuta la herramienta en nuestro backend Node (catálogo/CRM)."""
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(
                f"{BACKEND_BASE}/voice/tool",
                json={"name": name, "args": args, "callId": call_id, "phone": phone},
                headers={"x-voice-secret": VOICE_SECRET, "Content-Type": "application/json"},
                timeout=aiohttp.ClientTimeout(total=8),
            ) as r:
                data = await r.json()
                return data.get("result", {})
    except Exception as e:  # noqa: BLE001
        return {"error": f"backend: {e}"}


async def run_bot(websocket, call_data: dict):
    call_id = call_data.get("call_id") or ""
    phone = call_data.get("from") or ""

    serializer = TwilioFrameSerializer(
        stream_sid=call_data["stream_id"],
        call_sid=call_id,
        account_sid=os.getenv("TWILIO_ACCOUNT_SID", ""),
        auth_token=os.getenv("TWILIO_AUTH_TOKEN", ""),
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            vad_analyzer=SileroVADAnalyzer(params=VADParams(stop_secs=0.5)),
            serializer=serializer,
        ),
    )

    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY", ""), model="nova-2", language=Language.ES)
    llm = AnthropicLLMService(
        api_key=os.getenv("ANTHROPIC_API_KEY", ""),
        settings=AnthropicLLMService.Settings(
            model=os.getenv("VOICE_MODEL", "claude-haiku-4-5-20251001"),
            max_tokens=200,
            temperature=0.4,
        ),
    )
    # TTS Cartesia (español). El voice_id se saca de play.cartesia.ai → Voices (filtra Spanish).
    # Nota de versión: si tu pipecat-ai exige el patrón Settings, usa
    # CartesiaTTSService(api_key=..., settings=CartesiaTTSService.Settings(voice=os.getenv("CARTESIA_VOICE_ID"), language="es"))
    tts = CartesiaTTSService(
        api_key=os.getenv("CARTESIA_API_KEY", ""),
        voice_id=os.getenv("CARTESIA_VOICE_ID", ""),
    )

    context = LLMContext(messages=[{"role": "system", "content": SYSTEM_PROMPT}], tools=_tools())
    # Fin de turno por SILENCIO (no Smart Turn): predecible, sin "dead air".
    # start = inicio por VAD (permite interrumpir); stop = tras ~0.6s de silencio, responde.
    aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                start=[VADUserTurnStartStrategy(enable_interruptions=True)],
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.6)],
            ),
        ),
    )

    def _make_handler(tool_name: str):
        async def handler(params: FunctionCallParams):
            res = await _call_backend_tool(tool_name, params.arguments or {}, call_id, phone)
            await params.result_callback(res)
        return handler

    for tname in ("consultar_programas", "detalle_programa", "registrar_interes_crm", "transferir_a_asesor"):
        llm.register_function(tname, _make_handler(tname))

    pipeline = Pipeline([
        transport.input(),
        stt,
        aggregator.user(),
        llm,
        tts,
        transport.output(),
        aggregator.assistant(),
    ])
    task = PipelineTask(
        pipeline,
        params=PipelineParams(
            audio_in_sample_rate=8000,
            audio_out_sample_rate=8000,
            allow_interruptions=True,
        ),
    )

    started = time.time()

    @transport.event_handler("on_client_connected")
    async def _connected(_t, _c):
        await task.queue_frames([LLMRunFrame()])  # el bot saluda primero (según el system prompt)

    @transport.event_handler("on_client_disconnected")
    async def _disconnected(_t, _c):
        transcript = ""
        try:
            msgs = context.get_messages() if hasattr(context, "get_messages") else getattr(context, "messages", [])
            parts = []
            for m in msgs:
                role = m.get("role") if isinstance(m, dict) else getattr(m, "role", None)
                content = m.get("content") if isinstance(m, dict) else getattr(m, "content", None)
                if role in ("user", "assistant") and isinstance(content, str):
                    parts.append(f"{role}: {content}")
            transcript = "\n".join(parts)
        except Exception:  # noqa: BLE001
            transcript = ""
        dur = int(time.time() - started)
        try:
            async with aiohttp.ClientSession() as s:
                await s.post(
                    f"{BACKEND_BASE}/voice/call/finish",
                    json={"callId": call_id, "phone": phone, "type": 2, "duration": dur, "transcript": transcript},
                    headers={"x-voice-secret": VOICE_SECRET, "Content-Type": "application/json"},
                    timeout=aiohttp.ClientTimeout(total=8),
                )
        except Exception:  # noqa: BLE001
            pass
        await task.cancel()

    await PipelineRunner().run(task)
