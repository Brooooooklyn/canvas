// drawImage(svgImage, ...args) with empty or outside source rects: Chrome
// draws nothing (canvas_2d_recorder_context.cc DrawImageInternal clips the
// source rect to the image and returns on an empty one).
const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#00f"/><rect width="20" height="20" fill="#f00"/></svg>'
const c = (args) => ({ svg, w: 40, h: 40, args })
module.exports = {
  empty_sw: c([0, 0, 0, 10, 0, 0, 40, 40]),
  empty_sh: c([0, 0, 10, 0, 0, 0, 40, 40]),
  empty_dw: c([0, 0, 40, 40, 0, 0, 0, 40]),
  src_outside: c([50, 50, 10, 10, 0, 0, 40, 40]),
  src_part_outside: c([30, 30, 20, 20, 0, 0, 40, 40]),
  src_negative_size: c([20, 20, -20, -20, 0, 0, 40, 40]),
}
