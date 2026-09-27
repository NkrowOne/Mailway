/**
 * Conectar un buzón a sus dispositivos: datos de conexión, perfil de Apple,
 * Outlook, Thunderbird, Android, webmail y enlace/QR para enviar al titular.
 * Se usa en el panel (Buzones) y en el portal. Pendiente de implementar.
 */
export interface ConectarBuzonProps {
  mailboxId: string;
  email: string;
  /** Contraseña recién generada (solo tras crear o restablecer el buzón). */
  passwordRecienGenerada?: string;
}

export function ConectarBuzon(_props: ConectarBuzonProps) {
  return null;
}
