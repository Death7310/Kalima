/* Kalima — boot: build the world, the Kali machine and the first shell.
 * Loaded last. The browser UI and the Node test harness both call K.boot().
 */
;(function (root) {
  'use strict';
  const K = root.K;

  /**
   * K.boot({ term, home }) -> { machine, shell, term }
   *   home: optional tree from K.saveHome() to restore /home/kali
   * Creates a fresh world and Kali box. Safe to call again to reset everything.
   */
  /** Serializable snapshot of the learner's home directory (for localStorage). */
  K.saveHome = function () { return K.kali ? K.kali.vfs.exportTree('/home/kali') : null; };

  K.boot = async function (o) {
    o = o || {};
    K.bootTime = null;
    K.net.load(K.makeWorld());
    const kh = K.net.hostById('kali');
    const lab = K.net.world.nets[0];
    const machine = new K.Machine({
      hostname: 'kali', profile: 'kali', hostId: 'kali',
      users: [{
        name: 'kali', uid: 1000, gid: 1000, gecos: 'Kali,,,', home: '/home/kali', shell: '/usr/bin/zsh', password: 'kali',
        groups: ['adm', 'dialout', 'cdrom', 'floppy', 'sudo', 'audio', 'dip', 'video', 'plugdev', 'users', 'netdev', 'wireshark', 'kaboxer'],
      }],
      ifaces: [{ name: 'eth0', ip: kh.ip, bits: K.util.parseCidr(lab.cidr).bits, mac: kh.mac, kind: 'ether', state: 'UP', mtu: 1500 }],
      routes: [{ dst: 'default', via: lab.gateway, dev: 'eth0', proto: 'dhcp', metric: 100 }, { dst: lab.cidr, dev: 'eth0', src: kh.ip, proto: 'kernel', metric: 100 }],
      dns: [K.net.world.dns.lab], search: ['halcyon.lab'],
    });
    K.net.registerMachine(machine);
    K.kali = machine;
    // restore the learner's saved home directory (see K.saveHome)
    if (o.home) { try { machine.vfs.importTree('/home/kali', o.home); } catch (e) { if (K.debug) console.error(e); } }
    const term = o.term || new K.HeadlessTerm();
    const shell = new K.Shell({ machine, term, user: 'kali', interactive: true, login: true });
    await shell.init();
    shell._inited = true;
    K.shell = shell;
    K.events.emit('boot', { machine, shell, term });
    return { machine, shell, term };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
