/* Kalima — in-memory virtual filesystem with POSIX-style permissions.
 *
 * Node shapes:
 *   dir   { t:'d', mode, uid, gid, mtime, ino, ch: Map<name,node> }
 *   file  { t:'f', mode, uid, gid, mtime, ino, data: string, dyn?: key }
 *         (vsize?: reported size for simulated binaries whose data is only a stub)
 *   link  { t:'l', mode:0o777, uid, gid, mtime, ino, target: string }
 *   chdev { t:'c', mode, uid, gid, mtime, ino, dev: 'null'|'zero'|'random'|'tty' }
 *
 * Paths given to VFS methods must be absolute; use VFS.abs(path, cwd) first, or use
 * the FsView facade (ctx.fs in commands) which applies cwd, credentials and umask.
 */
;(function (root) {
  'use strict';
  const K = root.K;

  const ERR = {
    ENOENT: 'No such file or directory',
    EACCES: 'Permission denied',
    EISDIR: 'Is a directory',
    ENOTDIR: 'Not a directory',
    EEXIST: 'File exists',
    ENOTEMPTY: 'Directory not empty',
    EPERM: 'Operation not permitted',
    ELOOP: 'Too many levels of symbolic links',
    EINVAL: 'Invalid argument',
    EBUSY: 'Device or resource busy',
    EXDEV: 'Invalid cross-device link',
    ENOSPC: 'No space left on device',
  };

  class FsError extends Error {
    constructor(code, path) {
      super(ERR[code] || code);
      this.name = 'FsError';
      this.code = code;
      this.path = path;
    }
  }
  K.FsError = FsError;
  K.ERRNO = ERR;

  const ROOT_CRED = { uid: 0, gid: 0, groups: [0] };
  K.ROOT_CRED = ROOT_CRED;

  // Dynamic file generators: K.dynFiles.register('proc.uptime', (machine) => '...')
  K.dynFiles = {
    _g: Object.create(null),
    register(key, fn) { this._g[key] = fn; },
    get(key) { return this._g[key]; },
  };

  class VFS {
    constructor() {
      this._ino = 2;
      this.machine = null; // set by Machine
      this.root = this._mk('d', 0o755, 0, 0);
      this.onChange = null; // optional callback(path) for persistence
    }

    _mk(t, mode, uid, gid) {
      const n = { t, mode, uid: uid | 0, gid: gid | 0, mtime: K.clock.now(), ino: this._ino++ };
      if (t === 'd') n.ch = new Map();
      if (t === 'f') n.data = '';
      return n;
    }

    /** Lexically normalise `path` against `cwd` into an absolute path (no symlink resolution). */
    static abs(path, cwd) {
      path = String(path == null ? '' : path);
      if (path === '') path = '.';
      const parts = (path[0] === '/' ? path : (cwd || '/') + '/' + path).split('/');
      const out = [];
      for (const p of parts) {
        if (p === '' || p === '.') continue;
        if (p === '..') out.pop(); else out.push(p);
      }
      return '/' + out.join('/');
    }
    static dirname(p) { p = VFS.abs(p, '/'); const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
    static basename(p) {
      p = String(p); while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
      if (p === '/') return '/';
      const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1);
    }

    /** May `cred` access `node` with permission `p` ('r' | 'w' | 'x')? */
    access(node, cred, p) {
      cred = cred || ROOT_CRED;
      if (cred.uid === 0) return p !== 'x' || node.t === 'd' || (node.mode & 0o111) !== 0;
      const bit = p === 'r' ? 4 : p === 'w' ? 2 : 1;
      let shift = 0;
      if (cred.uid === node.uid) shift = 6;
      else if (cred.gid === node.gid || (cred.groups || []).indexOf(node.gid) >= 0) shift = 3;
      return ((node.mode >> shift) & bit) !== 0;
    }

    /**
     * Walk to a path. Returns { node, parent, name, path } where `path` is the fully
     * resolved absolute path. Throws FsError. Options:
     *   cred    credentials used for directory search ('x') checks (default root)
     *   follow  follow a symlink in the final component (default true)
     *   parent  resolve only the parent; `node` may be undefined when the leaf is missing
     */
    walk(path, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      let depth = 0;
      const self = this;
      function go(p) {
        const parts = p.split('/').filter(Boolean);
        let cur = self.root; let curPath = '';
        let parent = null; let name = '';
        if (!parts.length) return { node: self.root, parent: null, name: '', path: '/' };
        for (let i = 0; i < parts.length; i++) {
          const last = i === parts.length - 1;
          if (cur.t !== 'd') throw new FsError('ENOTDIR', path);
          if (!self.access(cur, cred, 'x')) throw new FsError('EACCES', path);
          const child = cur.ch.get(parts[i]);
          parent = cur; name = parts[i];
          if (!child) {
            if (last && o.parent) return { node: undefined, parent, name, path: curPath + '/' + name };
            throw new FsError('ENOENT', path);
          }
          if (child.t === 'l' && (!last || o.follow !== false)) {
            if (++depth > 40) throw new FsError('ELOOP', path);
            const target = VFS.abs(child.target, curPath || '/');
            const restParts = parts.slice(i + 1);
            return go(restParts.length ? target + '/' + restParts.join('/') : target);
          }
          curPath += '/' + parts[i];
          cur = child;
        }
        return { node: cur, parent, name, path: curPath || '/' };
      }
      return go(VFS.abs(path, '/'));
    }

    lookup(path, o) { return this.walk(path, o).node; }
    exists(path, o) { try { return !!this.walk(path, o).node; } catch (e) { return false; } }
    realpath(path, o) { return this.walk(path, o).path; }

    _content(node) {
      if (node.t === 'c') return '';
      if (node.dyn) {
        const g = K.dynFiles.get(node.dyn);
        try { return g ? String(g(this.machine, node)) : ''; } catch (e) { return ''; }
      }
      return node.data;
    }

    _info(node) {
      let size = 0; let nlink = 1;
      if (node.t === 'f') size = node.vsize != null ? node.vsize : K.util.byteLen(this._content(node));
      else if (node.t === 'd') {
        size = 4096; nlink = 2;
        for (const c of node.ch.values()) if (c.t === 'd') nlink++;
      } else if (node.t === 'l') size = node.target.length;
      return {
        type: node.t, mode: node.mode, uid: node.uid, gid: node.gid, size, mtime: node.mtime,
        ino: node.ino, nlink, target: node.target, dev: node.dev,
        isDir: node.t === 'd', isFile: node.t === 'f', isLink: node.t === 'l', isDev: node.t === 'c',
      };
    }

    stat(path, o) { return this._info(this.walk(path, o).node); }
    lstat(path, o) { return this._info(this.walk(path, Object.assign({}, o, { follow: false })).node); }

    read(path, o) {
      o = o || {};
      const node = this.walk(path, o).node;
      if (node.t === 'd') throw new FsError('EISDIR', path);
      if (!this.access(node, o.cred, 'r')) throw new FsError('EACCES', path);
      if (node.t === 'c') {
        if (node.dev === 'zero') return '\0'.repeat(o.length || 0);
        if (node.dev === 'random') {
          const r = K.util.prng('urandom:' + K.clock.now() + ':' + (this._rc = (this._rc || 0) + 1));
          let s = ''; for (let i = 0; i < (o.length || 64); i++) s += String.fromCharCode(Math.floor(r() * 256));
          return s;
        }
        return '';
      }
      return this._content(node);
    }

    /** Write a file. Options: cred, append, mode (creation mode before umask), umask, uid/gid for new files. */
    write(path, data, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const w = this.walk(path, { cred, parent: true });
      data = String(data == null ? '' : data);
      if (w.node) {
        const node = w.node;
        if (node.t === 'd') throw new FsError('EISDIR', path);
        if (!this.access(node, cred, 'w')) throw new FsError('EACCES', path);
        if (node.t === 'c') return;
        if (node.dyn) { delete node.dyn; node.data = ''; }
        delete node.vsize;
        node.data = o.append ? node.data + data : data;
        node.mtime = K.clock.now();
      } else {
        if (!w.parent) throw new FsError('ENOENT', path);
        if (!this.access(w.parent, cred, 'w') || !this.access(w.parent, cred, 'x')) throw new FsError('EACCES', path);
        const mode = (o.mode == null ? 0o666 : o.mode) & ~(o.umask == null ? 0o022 : o.umask);
        const node = this._mk('f', mode, cred.uid, cred.gid);
        node.data = data;
        w.parent.ch.set(w.name, node);
        w.parent.mtime = node.mtime;
      }
      if (this.onChange) this.onChange(w.path);
    }

    mkdir(path, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const abs = VFS.abs(path, '/');
      if (o.parents) {
        const parts = abs.split('/').filter(Boolean);
        let cur = '';
        for (let i = 0; i < parts.length; i++) {
          cur += '/' + parts[i];
          let st = null;
          try { st = this.walk(cur, { cred }).node; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (st) { if (st.t !== 'd') throw new FsError(i === parts.length - 1 ? 'EEXIST' : 'ENOTDIR', path); continue; }
          this.mkdir(cur, { cred, mode: o.mode, umask: o.umask });
        }
        return;
      }
      const w = this.walk(abs, { cred, parent: true, follow: false });
      if (w.node) throw new FsError('EEXIST', path);
      if (!w.parent) throw new FsError('EEXIST', path);
      if (!this.access(w.parent, cred, 'w') || !this.access(w.parent, cred, 'x')) throw new FsError('EACCES', path);
      const mode = (o.mode == null ? 0o777 : o.mode) & ~(o.umask == null ? 0o022 : o.umask);
      const node = this._mk('d', mode, cred.uid, cred.gid);
      w.parent.ch.set(w.name, node);
      w.parent.mtime = node.mtime;
      if (this.onChange) this.onChange(w.path);
    }

    readdir(path, o) {
      o = o || {};
      const node = this.walk(path, o).node;
      if (node.t !== 'd') throw new FsError('ENOTDIR', path);
      if (!this.access(node, o.cred, 'r')) throw new FsError('EACCES', path);
      return Array.from(node.ch.keys()).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }

    _checkRemove(w, cred, path) {
      if (!w.parent) throw new FsError('EBUSY', path);
      if (!this.access(w.parent, cred, 'w') || !this.access(w.parent, cred, 'x')) throw new FsError('EACCES', path);
      // sticky bit: only the owner of the file or directory (or root) may remove
      if ((w.parent.mode & 0o1000) && cred.uid !== 0 && cred.uid !== w.node.uid && cred.uid !== w.parent.uid) {
        throw new FsError('EPERM', path);
      }
    }

    unlink(path, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const w = this.walk(path, { cred, follow: false });
      if (w.node.t === 'd') throw new FsError('EISDIR', path);
      this._checkRemove(w, cred, path);
      w.parent.ch.delete(w.name);
      w.parent.mtime = K.clock.now();
      if (this.onChange) this.onChange(w.path);
    }

    rmdir(path, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const w = this.walk(path, { cred, follow: false });
      if (w.node.t !== 'd') throw new FsError('ENOTDIR', path);
      if (w.node.ch.size) throw new FsError('ENOTEMPTY', path);
      this._checkRemove(w, cred, path);
      w.parent.ch.delete(w.name);
      w.parent.mtime = K.clock.now();
      if (this.onChange) this.onChange(w.path);
    }

    /** Recursive remove (rm -r). Throws on the first entry that cannot be removed. */
    rmTree(path, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const w = this.walk(path, { cred, follow: false });
      if (w.node.t === 'd') {
        if (!this.access(w.node, cred, 'r') || !this.access(w.node, cred, 'w') || !this.access(w.node, cred, 'x')) {
          if (w.node.ch.size) throw new FsError('EACCES', path);
        }
        for (const name of Array.from(w.node.ch.keys())) this.rmTree(w.path + '/' + name, o);
        this.rmdir(w.path, o);
      } else this.unlink(w.path, o);
    }

    rename(from, to, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const a = this.walk(from, { cred, follow: false });
      this._checkRemove(a, cred, from);
      const b = this.walk(to, { cred, parent: true, follow: false });
      if (!b.parent) throw new FsError('EBUSY', to);
      if (!this.access(b.parent, cred, 'w') || !this.access(b.parent, cred, 'x')) throw new FsError('EACCES', to);
      if ((b.path + '/').indexOf(a.path + '/') === 0 && a.node.t === 'd' && a.path !== b.path) throw new FsError('EINVAL', to);
      if (b.node) {
        if (b.node === a.node) return;
        if (b.node.t === 'd') {
          if (a.node.t !== 'd') throw new FsError('EISDIR', to);
          if (b.node.ch.size) throw new FsError('ENOTEMPTY', to);
        } else if (a.node.t === 'd') throw new FsError('ENOTDIR', to);
      }
      a.parent.ch.delete(a.name);
      b.parent.ch.set(b.name, a.node);
      a.parent.mtime = b.parent.mtime = K.clock.now();
      if (this.onChange) { this.onChange(a.path); this.onChange(b.path); }
    }

    chmod(path, mode, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const w = this.walk(path, { cred });
      if (cred.uid !== 0 && cred.uid !== w.node.uid) throw new FsError('EPERM', path);
      w.node.mode = mode & 0o7777;
      if (this.onChange) this.onChange(w.path);
    }

    chown(path, uid, gid, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const w = this.walk(path, { cred, follow: o.follow !== false });
      if (cred.uid !== 0) {
        // a non-root owner may only change the group to one they belong to
        const groupOnly = uid == null || uid === w.node.uid;
        const okGroup = gid == null || gid === cred.gid || (cred.groups || []).indexOf(gid) >= 0;
        if (!(cred.uid === w.node.uid && groupOnly && okGroup)) throw new FsError('EPERM', path);
      }
      if (uid != null) w.node.uid = uid;
      if (gid != null) w.node.gid = gid;
      if (this.onChange) this.onChange(w.path);
    }

    symlink(target, path, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const w = this.walk(path, { cred, parent: true, follow: false });
      if (w.node) throw new FsError('EEXIST', path);
      if (!this.access(w.parent, cred, 'w') || !this.access(w.parent, cred, 'x')) throw new FsError('EACCES', path);
      const node = this._mk('l', 0o777, cred.uid, cred.gid);
      node.target = String(target);
      w.parent.ch.set(w.name, node);
      if (this.onChange) this.onChange(w.path);
    }

    readlink(path, o) {
      const node = this.walk(path, Object.assign({}, o, { follow: false })).node;
      if (node.t !== 'l') throw new FsError('EINVAL', path);
      return node.target;
    }

    utimes(path, mtime, o) {
      o = o || {};
      const cred = o.cred || ROOT_CRED;
      const node = this.walk(path, { cred }).node;
      if (cred.uid !== 0 && cred.uid !== node.uid && !this.access(node, cred, 'w')) throw new FsError('EACCES', path);
      node.mtime = mtime == null ? K.clock.now() : mtime;
    }

    /* ------------------------------------------------------------ seeding
     * Seeding bypasses permission checks and creates parents as root 0755.
     * Used to build the base system image and lab hosts.
     */
    seedDir(path, o) {
      o = o || {};
      const parts = VFS.abs(path, '/').split('/').filter(Boolean);
      let cur = this.root;
      for (let i = 0; i < parts.length; i++) {
        let c = cur.ch.get(parts[i]);
        if (!c) {
          c = this._mk('d', 0o755, 0, 0);
          if (o.mtime != null) c.mtime = o.mtime;
          cur.ch.set(parts[i], c);
        }
        if (c.t === 'l') c = this.walk('/' + parts.slice(0, i + 1).join('/')).node;
        cur = c;
      }
      if (o.mode != null) cur.mode = o.mode;
      if (o.uid != null) cur.uid = o.uid;
      if (o.gid != null) cur.gid = o.gid;
      if (o.mtime != null) cur.mtime = o.mtime;
      return cur;
    }

    /** seed(path, content | {dyn:key}, {mode, uid, gid, mtime}) */
    seed(path, content, o) {
      o = o || {};
      const abs = VFS.abs(path, '/');
      const dir = this.seedDir(VFS.dirname(abs), o.mtime != null ? { mtime: undefined } : undefined);
      const node = this._mk('f', o.mode == null ? 0o644 : o.mode, o.uid || 0, o.gid || 0);
      if (content && typeof content === 'object' && content.dyn) node.dyn = content.dyn;
      else node.data = String(content == null ? '' : content);
      if (o.mtime != null) node.mtime = o.mtime;
      dir.ch.set(VFS.basename(abs), node);
      return node;
    }

    seedLink(path, target, o) {
      o = o || {};
      const abs = VFS.abs(path, '/');
      const dir = this.seedDir(VFS.dirname(abs));
      const node = this._mk('l', 0o777, o.uid || 0, o.gid || 0);
      node.target = target;
      if (o.mtime != null) node.mtime = o.mtime;
      dir.ch.set(VFS.basename(abs), node);
      return node;
    }

    seedDev(path, dev, mode) {
      const abs = VFS.abs(path, '/');
      const dir = this.seedDir(VFS.dirname(abs));
      const node = this._mk('c', mode == null ? 0o666 : mode, 0, 0);
      node.dev = dev;
      dir.ch.set(VFS.basename(abs), node);
      return node;
    }

    /** Set owner (and optionally mode) recursively on an existing subtree. */
    seedOwn(path, uid, gid) {
      const walk = (n) => { n.uid = uid; n.gid = gid; if (n.t === 'd') for (const c of n.ch.values()) walk(c); };
      try { walk(this.walk(path, { follow: false }).node); } catch (e) { /* ignore */ }
    }

    /* -------------------------------------------------------- persistence */
    exportTree(path) {
      let node;
      try { node = this.walk(path, { follow: false }).node; } catch (e) { return null; }
      const enc = (n) => {
        const o = { t: n.t, m: n.mode, u: n.uid, g: n.gid, mt: n.mtime };
        if (n.t === 'd') { o.c = {}; for (const [k, v] of n.ch) o.c[k] = enc(v); }
        else if (n.t === 'f') { if (n.dyn) o.dyn = n.dyn; else o.d = n.data; }
        else if (n.t === 'l') o.l = n.target;
        else if (n.t === 'c') o.dev = n.dev;
        return o;
      };
      return enc(node);
    }

    importTree(path, json) {
      if (!json) return;
      const dec = (o) => {
        const n = this._mk(o.t, o.m, o.u, o.g);
        n.mtime = o.mt;
        if (o.t === 'd') for (const k of Object.keys(o.c || {})) n.ch.set(k, dec(o.c[k]));
        else if (o.t === 'f') { if (o.dyn) n.dyn = o.dyn; else n.data = o.d || ''; }
        else if (o.t === 'l') n.target = o.l;
        else if (o.t === 'c') n.dev = o.dev;
        return n;
      };
      const abs = VFS.abs(path, '/');
      if (abs === '/') { this.root = dec(json); return; }
      const dir = this.seedDir(VFS.dirname(abs));
      dir.ch.set(VFS.basename(abs), dec(json));
    }
  }
  K.VFS = VFS;

  /* ----------------------------------------------------------------- FsView
   * Convenience facade bound to a cwd getter, credentials and umask. This is
   * what commands receive as ctx.fs. All paths may be relative.
   */
  class FsView {
    constructor(vfs, getCwd, cred, getUmask) {
      this.vfs = vfs;
      this._cwd = typeof getCwd === 'function' ? getCwd : () => getCwd || '/';
      this.cred = cred || ROOT_CRED;
      this._umask = typeof getUmask === 'function' ? getUmask : () => (getUmask == null ? 0o022 : getUmask);
    }
    get cwd() { return this._cwd(); }
    abs(p) { return VFS.abs(p, this._cwd()); }
    _o(extra) { return Object.assign({ cred: this.cred, umask: this._umask() }, extra); }
    read(p, o) { return this.vfs.read(this.abs(p), this._o(o)); }
    write(p, data, o) { return this.vfs.write(this.abs(p), data, this._o(o)); }
    append(p, data, o) { return this.vfs.write(this.abs(p), data, this._o(Object.assign({ append: true }, o))); }
    stat(p) { return this.vfs.stat(this.abs(p), this._o()); }
    lstat(p) { return this.vfs.lstat(this.abs(p), this._o()); }
    exists(p) { return this.vfs.exists(this.abs(p), this._o({ follow: false })) ; }
    isDir(p) { try { return this.stat(p).isDir; } catch (e) { return false; } }
    isFile(p) { try { return this.stat(p).isFile; } catch (e) { return false; } }
    readdir(p) { return this.vfs.readdir(this.abs(p), this._o()); }
    mkdir(p, o) { return this.vfs.mkdir(this.abs(p), this._o(o)); }
    unlink(p) { return this.vfs.unlink(this.abs(p), this._o()); }
    rmdir(p) { return this.vfs.rmdir(this.abs(p), this._o()); }
    rmTree(p) { return this.vfs.rmTree(this.abs(p), this._o()); }
    rename(a, b) { return this.vfs.rename(this.abs(a), this.abs(b), this._o()); }
    chmod(p, mode) { return this.vfs.chmod(this.abs(p), mode, this._o()); }
    chown(p, uid, gid, o) { return this.vfs.chown(this.abs(p), uid, gid, this._o(o)); }
    symlink(target, p) { return this.vfs.symlink(target, this.abs(p), this._o()); }
    readlink(p) { return this.vfs.readlink(this.abs(p), this._o()); }
    realpath(p) { return this.vfs.realpath(this.abs(p), this._o()); }
    utimes(p, mtime) { return this.vfs.utimes(this.abs(p), mtime, this._o()); }
    /** May the current credentials access path with 'r' | 'w' | 'x'? (false when missing) */
    can(p, perm) {
      try { return this.vfs.access(this.vfs.walk(this.abs(p), { cred: this.cred }).node, this.cred, perm); }
      catch (e) { return false; }
    }
  }
  K.FsView = FsView;
})(typeof globalThis !== 'undefined' ? globalThis : this);
