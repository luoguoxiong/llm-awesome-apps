// starter_ai_agents/ai_data_analysis_agent/frontend/src/components/EChartBlock.tsx
// ECharts 渲染块:Agent 输出的 ```echarts JSON option → 图表(等价源可视化应用的沙箱图表)。
import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

interface EChartBlockProps {
  /** 合法 ECharts option(已通过 JSON.parse) */
  option: unknown;
}

export function EChartBlock({ option }: EChartBlockProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = echarts.init(el);
    chart.setOption(option as echarts.EChartsCoreOption);
    const onResize = () => chart.resize();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      chart.dispose();
    };
  }, [option]);

  return (
    <div className="echart-wrap">
      <div className="echart-block" ref={ref} />
    </div>
  );
}

/** 校验并解析 echarts JSON(供 ChatMessage 使用) */
export function parseEchartOption(raw: string): { option?: unknown; error?: string } {
  const text = raw.trim();
  if (!text) return { error: '图表配置为空' };
  try {
    return { option: JSON.parse(text) };
  } catch {
    return { error: '图表 JSON 不合法' };
  }
}
