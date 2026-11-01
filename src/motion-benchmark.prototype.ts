// THROWAWAY: run without screenshots/recording. Three 3-second pan/input samples by default.
import type { MotionExperiment, Options } from "./Motion-canvas.prototype";

export async function benchmarkMotion(p: MotionExperiment, options: Partial<Options>, runs = 3, duration = 3000) {
  const setup = await p.setup(options);
  const themes = [];
  for (let i = 0; i < 4; i++) themes.push((await p.theme(i % 2 ? "dark" : "light")).ms);
  const samples = [];
  for (let run = 0; run < runs; run++) {
    const inputs: number[] = [];
    const deadline = performance.now() + duration;
    const [s] = await Promise.all([
      p.sample(duration, true),
      (async () => {
        if (!p.surfaces.size) return;
        for (let i = 0; i < 20 && performance.now() < deadline; i++) {
          const start = performance.now();
          await p.command(0, { type: "input", amount: String(100 + i) });
          inputs.push(performance.now() - start);
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      })(),
    ]);
    const sum = (values: Record<string, any>[], key: string) => values.reduce((a, b) => a + (b[key] || 0), 0);
    samples.push({
      elapsed: s.elapsed, gaps: s.gaps, longTasks: s.longTasks, longTaskTotal: s.longTaskTotal, inputs,
      raf: sum(s.after, "rafCount") - sum(s.before, "rafCount"),
      scheduled: sum(s.after, "scheduledCount") - sum(s.before, "scheduledCount"),
      ticks: sum(s.after, "ticks") - sum(s.before, "ticks"),
      domWrites: sum(s.after, "domWrites") - sum(s.before, "domWrites"),
      workMs: sum(s.after, "workMs") - sum(s.before, "workMs"),
      nodes: sum(s.after, "nodes"), playingAnimations: sum(s.after, "playingAnimations"),
    });
  }
  return { options, setup, themes, samples };
}
