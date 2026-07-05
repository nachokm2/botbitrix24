"""Sonda para descubrir la API exacta de la Pipecat instalada. Correr: python probe.py"""
import importlib
import pkgutil

import pipecat
print("Pipecat", getattr(pipecat, "__version__", "?"))

# 1) Módulos de aggregators disponibles
import pipecat.processors.aggregators as agg
print("aggregators:", sorted(m.name for m in pkgutil.iter_modules(agg.__path__)))

# 2) Clases de contexto / aggregator candidatas
for mod in [
    "pipecat.processors.aggregators.llm_context",
    "pipecat.processors.aggregators.llm_response_universal",
    "pipecat.processors.aggregators.openai_llm_context",
]:
    try:
        m = importlib.import_module(mod)
        names = [n for n in dir(m) if ("Context" in n or "Aggregator" in n)]
        print("OK ", mod, "->", names)
    except Exception as e:
        print("NO ", mod, "->", type(e).__name__, e)

# 3) Símbolos clave (import puntual)
checks = [
    ("pipecat.pipeline.task", "PipelineTask"),
    ("pipecat.pipeline.runner", "PipelineRunner"),
    ("pipecat.pipeline.task", "PipelineParams"),
    ("pipecat.services.anthropic.llm", "AnthropicLLMService"),
    ("pipecat.services.deepgram.stt", "DeepgramSTTService"),
    ("pipecat.services.cartesia.tts", "CartesiaTTSService"),
    ("pipecat.services.llm_service", "FunctionCallParams"),
    ("pipecat.adapters.schemas.function_schema", "FunctionSchema"),
    ("pipecat.adapters.schemas.tools_schema", "ToolsSchema"),
    ("pipecat.transports.websocket.fastapi", "FastAPIWebsocketTransport"),
    ("pipecat.transports.websocket.fastapi", "FastAPIWebsocketParams"),
    ("pipecat.serializers.twilio", "TwilioFrameSerializer"),
    ("pipecat.runner.utils", "parse_telephony_websocket"),
    ("pipecat.audio.vad.silero", "SileroVADAnalyzer"),
    ("pipecat.frames.frames", "LLMRunFrame"),
]
for mod, cls in checks:
    try:
        m = importlib.import_module(mod)
        getattr(m, cls)
        print("OK ", f"{mod}.{cls}")
    except Exception as e:
        print("NO ", f"{mod}.{cls}", "->", type(e).__name__, e)

# 4) ¿AnthropicLLMService.create_context_aggregator existe?
try:
    from pipecat.services.anthropic.llm import AnthropicLLMService
    print("create_context_aggregator:", hasattr(AnthropicLLMService, "create_context_aggregator"))
except Exception as e:
    print("anthropic import fail:", e)
