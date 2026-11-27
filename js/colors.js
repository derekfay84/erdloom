/*
 * Group colours, shared by the diagram, the outline and the docs so a group has
 * the same colour everywhere. A TableGroup's own [color: …] setting wins;
 * otherwise groups take colours from the palette in the order they're defined.
 * The palette is picked to read on both the light and the dark theme.
 * Works in the browser (window.DBMLColors) and in Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DBMLColors = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GROUP_PALETTE = [
    '#3A7BD5', // blue
    '#0E9F7E', // green-teal
    '#E07A1F', // orange
    '#8E5BD9', // purple
    '#D14D7E', // pink
    '#1C9CB5', // cyan
    '#B98A12', // ochre
    '#5E6AD2', // indigo
    '#4E9A2F', // green
    '#C2453F', // red
  ];

  function groupColor(model, group) {
    if (group && group.color) return group.color;
    const i = model && model.groups ? model.groups.indexOf(group) : -1;
    return GROUP_PALETTE[(i < 0 ? 0 : i) % GROUP_PALETTE.length];
  }

  // Colour for a group given only its name (for places that have the name, not the object).
  function groupColorByName(model, name) {
    const g = model && model.groups ? model.groups.find((x) => x.name === name) : null;
    return g ? groupColor(model, g) : GROUP_PALETTE[0];
  }

  return { GROUP_PALETTE, groupColor, groupColorByName };
});
