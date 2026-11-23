import * as THREE from 'three';
import { expect, it } from 'vitest';
import { ALL_VARIANTS } from '../src/data/models';
import { buildPlaceholderVehicle } from '../src/geometry/placeholder';

it.each(ALL_VARIANTS.map(v => [v.id, v] as const))('%s：从前方可见宽于主格栅的下进气口，三根横条露在保险杠之前', (_id, v) => {
  const { root } = buildPlaceholderVehicle(v);
  const trim = root.getObjectByName('trim') as THREE.Mesh;
  const colors = trim.geometry.getAttribute('color');
  const direction = new THREE.Vector3(0, 0, -1);
  const ray = new THREE.Raycaster();
  const rgb = new THREE.Color();
  const colorAt = (x: number, y: number) => {
    ray.set(new THREE.Vector3(x, y, v.lengthM / 2 + 0.1), direction);
    const face = ray.intersectObject(trim)[0]?.face;
    if (!face) return null;
    return rgb.setRGB(colors.getX(face.a), colors.getY(face.a), colors.getZ(face.a)).getHex();
  };
  // Sample outside the +/-0.42 m upper grille, on both sides. Count distinct light strips,
  // not triangles: an intake hidden behind the bumper would present a single rubber colour.
  for (const x of [-0.45, 0.45]) {
    const backing = colorAt(x, 0.44);
    expect(backing).not.toBeNull();
    expect(backing).not.toBe(colorAt(x, 0.42));
    let bars = 0;
    let previous = backing;
    for (let y = 0.45; y < 0.70; y += 0.005) {
      const color = colorAt(x, y);
      expect(color).not.toBeNull();
      if (color !== backing && previous === backing) bars++;
      previous = color;
    }
    expect(bars).toBe(3);
    expect(previous).toBe(backing);
  }
});
