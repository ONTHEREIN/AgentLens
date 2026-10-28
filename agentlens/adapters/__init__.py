"""被测对象适配层（PRD P1-4）。"""

from .base import AgentOutput, BaseAdapter
from .campus_copilot import CampusCopilotAdapter

__all__ = ["AgentOutput", "BaseAdapter", "CampusCopilotAdapter"]
