import { MOVE_LABELS, type MoveId } from '../../shared/engine/moves.ts';
import { h } from '../dom.ts';
import { ATTACK_POSES, GUARD, type Pose } from '../render/pose.ts';
import { solve, BONES, type Joints, type Vec } from '../render/rig.ts';

/** A static sheet of every attack's windup and strike pose, for tuning the animation. */
export function posesView(host: HTMLElement): void {
  const cells: HTMLElement[] = [];
  const draw = (label: string, pose: Pose) => {
    const c = h('canvas', { width: 220, height: 200 }) as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#f3efe4';
    ctx.fillRect(0, 0, 220, 200);
    ctx.strokeStyle = '#1f1b16';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 170);
    ctx.lineTo(220, 170);
    ctx.stroke();
    const P = 75;
    const j: Joints = solve(pose, 0, 0, 1);
    const S = (v: Vec) => ({ x: 80 + v.x * P, y: 170 - v.y * P });
    const line = (pts: (keyof Joints)[], color: string) => {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const [w, col] of [[10, '#1f1b16'], [6, color]] as const) {
        ctx.strokeStyle = col;
        ctx.lineWidth = w;
        ctx.beginPath();
        pts.map((k) => S(j[k])).forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.stroke();
      }
    };
    line(['shoulder', 'elbowB', 'handB'], '#b5612f');
    line(['hip', 'kneeB', 'ankleB', 'toeB'], '#b5612f');
    line(['hip', 'shoulder'], '#e07a3c');
    line(['hip', 'kneeF', 'ankleF', 'toeF'], '#e07a3c');
    line(['shoulder', 'elbowF', 'handF'], '#e07a3c');
    const hd = S(j.head);
    ctx.fillStyle = '#e07a3c';
    ctx.beginPath();
    ctx.arc(hd.x, hd.y, BONES.headR * P, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    cells.push(h('figure.pose', null, c, h('figcaption', null, label)));
  };
  draw('Guard', GUARD);
  for (const [id, set] of Object.entries(ATTACK_POSES) as [MoveId, { windup: Pose; strike: Pose }][]) {
    draw(`${MOVE_LABELS[id]}: windup`, set.windup);
    draw(`${MOVE_LABELS[id]}: strike`, set.strike);
  }
  host.replaceChildren(h('div.page', null, h('h1', null, 'Poses'), h('div.pose-grid', null, ...cells)));
}
