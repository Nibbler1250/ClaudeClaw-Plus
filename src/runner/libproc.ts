/**
 * macOS libproc through `bun:ffi`: who a pid is, read in one call and to the microsecond. Shared
 * by the bus ownership guard (#595) and the PTY layer (#581), so that both ask the OS the same
 * way. Nothing here signals anything, spawns anything, or throws: an answer that cannot be had is
 * null, and every caller treats null as "cannot tell" (never as "the same process").
 */

/**
 * `proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof info)` fills a `struct proc_bsdinfo`.
 * Source: the macOS SDK header `<sys/proc_info.h>` (checked against MacOSX26.5.sdk): `PROC_PIDTBSDINFO`
 * is 3, `PROC_PIDTBSDINFO_SIZE` is `sizeof(struct proc_bsdinfo)` = 136. Layout (little-endian; arm64 and
 * x86_64 agree): twelve 4-byte fields `pbi_flags`..`rfu_1` (0..47, so `pbi_status` is at 4, `pbi_pid` at
 * 12, `pbi_uid` at 20), `pbi_comm[16]` (48), `pbi_name[32]` (64), six 4-byte fields `pbi_nfiles`..
 * `pbi_nice` (96..119, so `pbi_pgid` is at 100), then the two `uint64_t` fields `pbi_start_tvsec` (120)
 * and `pbi_start_tvusec` (128), which sit on their natural 8-byte alignment with no padding. The
 * status, uid and pgid offsets were checked against `ps` on a live process (#581, 27 Oct 2026).
 */
export const PROC_PIDTBSDINFO = 3;
export const PROC_BSDINFO_SIZE = 136;
export const BSDINFO_OFFSETS = {
  status: 4,
  pid: 12,
  uid: 20,
  comm: 48,
  name: 64,
  pgid: 100,
  startSec: 120,
  startUsec: 128,
} as const;

/** `proc_listpids(PROC_PGRP_ONLY, pgid, ...)`: the pids of one process group (`<libproc.h>`). */
export const PROC_PGRP_ONLY = 2;

/** `pbi_status` / `p_stat` of a zombie (`SZOMB`, `<sys/proc.h>`). libproc does not answer for one. */
export const SZOMB = 5;

/**
 * `sysctl({CTL_KERN, KERN_PROC, KERN_PROC_PID, pid})` fills one `struct kinfo_proc` (648 bytes on
 * arm64 and x86_64), and unlike `proc_pidinfo` it answers for a zombie: it is what `ps` reads. A
 * pid with no process leaves the length 0. Offsets (`<sys/sysctl.h>`, checked against libproc and
 * `ps` on a live process and a zombie, #581, 27 Oct 2026): `kp_proc.p_starttime` (a `timeval`:
 * `tv_sec` at 0, `tv_usec` at 8, the same instant libproc reports), `p_stat` at 36, `p_pid` at 40;
 * `kp_eproc.e_ppid` at 560 and `e_pgid` at 564.
 */
export const KINFO_PROC_SIZE = 648;
export const KINFO_OFFSETS = { startSec: 0, startUsec: 8, stat: 36, pid: 40, pgid: 564 } as const;
const KERN_PROC_PID_MIB = [1, 14, 1] as const; // CTL_KERN, KERN_PROC, KERN_PROC_PID

/** One `kinfo_proc` reading: what is needed of a pid that libproc would not answer for. */
export interface KinfoProc {
  pid: number;
  zombie: boolean;
  pgid: number;
  start: StartTime;
}

export interface StartTime {
  sec: number;
  usec: number;
}

/** One `proc_bsdinfo` reading of one pid. */
export interface BsdInfo {
  pid: number;
  status: number;
  uid: number;
  pgid: number;
  /** `pbi_name` when set (up to 32 bytes), else `pbi_comm` (16): for reports, never for identity. */
  name: string;
  start: StartTime;
}

const cString = (buf: Uint8Array, at: number, len: number): string => {
  const bytes = buf.subarray(at, at + len);
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
};

/** Decode a `proc_bsdinfo` buffer; null if it is short, not `pid`'s, or its start time is not sane. */
export function decodeBsdInfo(buf: Uint8Array, pid: number): BsdInfo | null {
  if (buf.byteLength < PROC_BSDINFO_SIZE) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getUint32(BSDINFO_OFFSETS.pid, true) !== pid) return null;
  const sec = Number(view.getBigUint64(BSDINFO_OFFSETS.startSec, true));
  const usec = Number(view.getBigUint64(BSDINFO_OFFSETS.startUsec, true));
  if (!Number.isSafeInteger(sec) || sec <= 0 || !(usec >= 0 && usec < 1_000_000)) return null;
  return {
    pid,
    status: view.getUint32(BSDINFO_OFFSETS.status, true),
    uid: view.getUint32(BSDINFO_OFFSETS.uid, true),
    pgid: view.getUint32(BSDINFO_OFFSETS.pgid, true),
    name: cString(buf, BSDINFO_OFFSETS.name, 32) || cString(buf, BSDINFO_OFFSETS.comm, 16),
    start: { sec, usec },
  };
}

/** Decode a `kinfo_proc` buffer; null if it is short, not `pid`'s, or its start time is not sane. */
export function decodeKinfoProc(buf: Uint8Array, pid: number): KinfoProc | null {
  if (buf.byteLength < KINFO_PROC_SIZE) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.getInt32(KINFO_OFFSETS.pid, true) !== pid) return null;
  const sec = Number(view.getBigInt64(KINFO_OFFSETS.startSec, true));
  const usec = view.getInt32(KINFO_OFFSETS.startUsec, true);
  if (!Number.isSafeInteger(sec) || sec <= 0 || !(usec >= 0 && usec < 1_000_000)) return null;
  return {
    pid,
    zombie: view.getUint8(KINFO_OFFSETS.stat) === SZOMB,
    pgid: view.getInt32(KINFO_OFFSETS.pgid, true),
    start: { sec, usec },
  };
}

/** Decode `pbi_start_tvsec` / `pbi_start_tvusec` from a `proc_bsdinfo` buffer; null if it is not `pid`'s. */
export function decodeBsdInfoStart(buf: Uint8Array, pid: number): StartTime | null {
  return decodeBsdInfo(buf, pid)?.start ?? null;
}

type ProcPidInfo = (
  pid: number,
  flavor: number,
  arg: bigint,
  buf: Uint8Array,
  size: number,
) => number;
type ProcListPids = (
  type: number,
  typeinfo: number,
  buf: Uint8Array | null,
  size: number,
) => number;
type Sysctl = (
  name: Int32Array,
  namelen: number,
  oldp: Uint8Array,
  oldlenp: BigUint64Array,
  newp: null,
  newlen: bigint,
) => number;
interface Lib {
  pidinfo: ProcPidInfo;
  listpids: ProcListPids;
  sysctl: Sysctl;
}
let lib: Lib | null | undefined;

/** libSystem through `bun:ffi` (built in; loaded lazily like runner.ts does). Null off Bun. */
function load(): Lib | null {
  if (lib !== undefined) return lib;
  lib = null;
  try {
    const ffi = require("bun:ffi") as {
      // biome-ignore lint/suspicious/noExplicitAny: bun:ffi is untyped under tsc
      dlopen: (name: string, symbols: Record<string, unknown>) => { symbols: any };
      FFIType: Record<string, number>;
    };
    for (const name of ["libSystem.B.dylib", "/usr/lib/libSystem.B.dylib"]) {
      try {
        const opened = ffi.dlopen(name, {
          proc_pidinfo: {
            args: [
              ffi.FFIType.i32,
              ffi.FFIType.i32,
              ffi.FFIType.u64,
              ffi.FFIType.ptr,
              ffi.FFIType.i32,
            ],
            returns: ffi.FFIType.i32,
          },
          proc_listpids: {
            args: [ffi.FFIType.u32, ffi.FFIType.u32, ffi.FFIType.ptr, ffi.FFIType.i32],
            returns: ffi.FFIType.i32,
          },
          sysctl: {
            args: [
              ffi.FFIType.ptr,
              ffi.FFIType.u32,
              ffi.FFIType.ptr,
              ffi.FFIType.ptr,
              ffi.FFIType.ptr,
              ffi.FFIType.u64,
            ],
            returns: ffi.FFIType.i32,
          },
        });
        lib = {
          pidinfo: opened.symbols.proc_pidinfo as ProcPidInfo,
          listpids: opened.symbols.proc_listpids as ProcListPids,
          sysctl: opened.symbols.sysctl as Sysctl,
        };
        break;
      } catch {
        // try the next name
      }
    }
  } catch {
    // no bun:ffi (not Bun): every reader below answers null
  }
  return lib;
}

/** Whether libproc can be asked at all on this platform. */
export function libprocAvailable(): boolean {
  return process.platform === "darwin" && load() !== null;
}

/**
 * One `proc_bsdinfo` reading of `pid`, or null when it cannot be had (never throws). Null for a
 * pid that is gone AND for a zombie: libproc answers neither, so null alone never says which.
 */
export function libprocBsdInfo(pid: number): BsdInfo | null {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0) return null;
  const call = load();
  if (!call) return null;
  try {
    const buf = new Uint8Array(PROC_BSDINFO_SIZE);
    if (call.pidinfo(pid, PROC_PIDTBSDINFO, 0n, buf, PROC_BSDINFO_SIZE) !== PROC_BSDINFO_SIZE)
      return null;
    return decodeBsdInfo(buf, pid);
  } catch {
    return null;
  }
}

/**
 * `pid` through `sysctl(KERN_PROC_PID)`: a reading (zombies included), `"gone"` when the kernel
 * has no such process, or null when it cannot be asked or answered oddly (never throws).
 */
export function kinfoProc(pid: number): KinfoProc | "gone" | null {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0) return null;
  const call = load();
  if (!call) return null;
  try {
    const buf = new Uint8Array(KINFO_PROC_SIZE);
    const len = new BigUint64Array([BigInt(KINFO_PROC_SIZE)]);
    const name = new Int32Array([...KERN_PROC_PID_MIB, pid]);
    if (call.sysctl(name, name.length, buf, len, null, 0n) !== 0) return null;
    if (len[0] === 0n) return "gone";
    return len[0] === BigInt(KINFO_PROC_SIZE) ? decodeKinfoProc(buf, pid) : null;
  } catch {
    return null;
  }
}

/** The microsecond start time of `pid` from libproc, or null when it cannot be had (never throws). */
export function libprocStartTime(pid: number): StartTime | null {
  return libprocBsdInfo(pid)?.start ?? null;
}

/**
 * The pids of process group `pgid`, zombies included, or null when they cannot be listed (never
 * throws). A buffer the kernel filled to the brim may have been cut short, so it is grown and the
 * call repeated; still full after that, the answer is null rather than a partial list.
 */
export function libprocGroupPids(pgid: number): number[] | null {
  if (process.platform !== "darwin" || !Number.isInteger(pgid) || pgid <= 1) return null;
  const call = load();
  if (!call) return null;
  try {
    let slots = Math.max(64, Math.ceil(call.listpids(PROC_PGRP_ONLY, pgid, null, 0) / 4) + 16);
    for (let attempt = 0; attempt < 3; attempt++, slots *= 4) {
      const buf = new Uint8Array(slots * 4);
      const bytes = call.listpids(PROC_PGRP_ONLY, pgid, buf, buf.byteLength);
      if (bytes < 0) return null;
      if (bytes < buf.byteLength) {
        const view = new DataView(buf.buffer, 0, bytes);
        const pids: number[] = [];
        for (let at = 0; at + 4 <= bytes; at += 4) {
          const pid = view.getInt32(at, true);
          if (pid > 0) pids.push(pid);
        }
        return pids;
      }
    }
    return null;
  } catch {
    return null;
  }
}
