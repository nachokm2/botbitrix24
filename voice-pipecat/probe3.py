"""Sonda 3: firmas para configurar el fin de turno por VAD/silencio. Correr (con venv): python probe3.py"""
import inspect


def sig(obj, name=None):
    name = name or getattr(obj, "__name__", str(obj))
    try:
        print(f"\n== {name}{inspect.signature(obj.__init__ if isinstance(obj, type) else obj)}")
    except Exception as e:
        print(f"\n== {name}  (sin firma: {e})")
    doc = (getattr(obj, "__doc__", None) or "").strip().splitlines()
    if doc:
        print("   doc:", doc[0][:160])


from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.turns.user_stop import (
    SpeechTimeoutUserTurnStopStrategy,
    TurnAnalyzerUserTurnStopStrategy,
)
from pipecat.turns.user_start import VADUserTurnStartStrategy

sig(LLMContextAggregatorPair)
sig(LLMUserAggregatorParams)
sig(SpeechTimeoutUserTurnStopStrategy)
sig(VADUserTurnStartStrategy)

# Campos "reales" de LLMUserAggregatorParams (por si es dataclass)
try:
    import dataclasses
    if dataclasses.is_dataclass(LLMUserAggregatorParams):
        print("\nLLMUserAggregatorParams dataclass fields:",
              [(f.name, f.default) for f in dataclasses.fields(LLMUserAggregatorParams)])
except Exception as e:
    print("dc:", e)

# Atributos públicos por si acaso
print("\nLLMUserAggregatorParams attrs:", [a for a in dir(LLMUserAggregatorParams) if not a.startswith("_")][:40])
