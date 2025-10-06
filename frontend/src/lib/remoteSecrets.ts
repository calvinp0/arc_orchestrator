type Listener = (pw: string) => void;

let current = "";
const subs = new Set<Listener>();

export function setRemotePassword(pw: string) {
  current = pw;
  subs.forEach(fn => fn(pw));
}

export function getRemotePassword() {
  return current;
}

export function onRemotePasswordChange(fn: Listener) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
