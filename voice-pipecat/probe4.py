"""Sonda 4 (última): firma de UserTurnStrategies. Correr con venv: python probe4.py"""
import dataclasses
import inspect

from pipecat.turns.user_turn_strategies import UserTurnStrategies

print("== UserTurnStrategies", inspect.signature(UserTurnStrategies.__init__))
if dataclasses.is_dataclass(UserTurnStrategies):
    print("fields:", [(f.name, getattr(f, "default", "?")) for f in dataclasses.fields(UserTurnStrategies)])
print("attrs:", [a for a in dir(UserTurnStrategies) if not a.startswith("_")])
