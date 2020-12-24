export function createCanvas(
  width: number,
  height: number,
): HTMLCanvasElement & {
  png(): Promise<Buffer>
}
