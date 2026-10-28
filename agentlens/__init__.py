"""AgentLens —— 给 AI 智能体做「分层归因体检」的测试平台。

从「测答案」到「测链路」：判定只是入场券，归因才是产品。
"""

from .schema import SCHEMA_VERSION, Trace

__version__ = "0.1.0"

__all__ = ["SCHEMA_VERSION", "Trace", "__version__"]
