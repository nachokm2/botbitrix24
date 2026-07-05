"""Sonda 2: descubrir cómo se configura el turn-taking (Smart Turn vs VAD) en esta Pipecat. Correr: python probe2.py"""
import pkgutil


def show_fields(cls, filt=("turn", "vad", "audio", "serial", "interrup")):
    print(f"== {cls.__module__}.{cls.__name__}")
    mf = getattr(cls, "model_fields", None)
    if not mf:
        print("   (sin model_fields)")
        return
    for k, v in mf.items():
        if any(t in k.lower() for t in filt):
            default = getattr(v, "default", "?")
            print(f"   {k} = {default!r}")


# 1) Params del transporte
try:
    from pipecat.transports.base_transport import TransportParams
    show_fields(TransportParams)
except Exception as e:
    print("TransportParams:", e)

try:
    from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams
    show_fields(FastAPIWebsocketParams)
except Exception as e:
    print("FastAPIWebsocketParams:", e)

# 2) Params del PipelineTask
try:
    from pipecat.pipeline.task import PipelineParams
    show_fields(PipelineParams, filt=("turn", "interrup", "audio"))
except Exception as e:
    print("PipelineParams:", e)

# 3) Params de los aggregators (aquí suele ir la estrategia de turno)
try:
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMUserAggregatorParams,
    )
    show_fields(LLMUserAggregatorParams, filt=("turn", "vad", "strateg", "interrup", "timeout", "secs"))
    # muestra TODOS sus campos también
    print("   [todos]:", list(getattr(LLMUserAggregatorParams, "model_fields", {}).keys()))
except Exception as e:
    print("LLMUserAggregatorParams:", e)

# 4) Clases de análisis de turno / estrategias disponibles
try:
    import pipecat.audio.turn as turnpkg
    print("audio.turn submódulos:", sorted(m.name for m in pkgutil.iter_modules(turnpkg.__path__)))
except Exception as e:
    print("audio.turn:", e)

for mod in ("pipecat.turns.user_start", "pipecat.turns.user_stop"):
    try:
        import importlib
        m = importlib.import_module(mod)
        print(mod, "->", [n for n in dir(m) if "Strategy" in n or "Turn" in n])
    except Exception as e:
        print(mod, "->", type(e).__name__, e)
