import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';
import {
  descargarFichero,
  fechaLarga,
  mailtoEnlace,
  mensajeError,
  type DatosConexion,
  type EnlaceConfiguracion,
  type EnlaceCreado,
} from '../lib/portal';
import { Button } from '../ui/Button';
import { Select } from '../ui/Field';
import { MarcaFondo, Cargando, Muestra } from '../ui/kit';
import { useToast } from '../ui/toast';
import { DatosManuales } from '../pages/portal/GuiasDispositivo';
import { AvisoError, claseEnlaceBoton } from '../pages/portal/comun';
import { useUsuario } from './gestion/consultas';
import { QR } from './QR';

/**
 * Conectar un buzón a sus dispositivos, desde el panel: enlace de
 * configuración para enviar al titular (con QR y correo preparado), datos de
 * conexión, perfil de Apple y webmail. Lo usa Buzones tras crear o
 * restablecer un buzón y desde la acción «Conexión».
 */
export interface ConectarBuzonProps {
  mailboxId: string;
  email: string;
  /** Contraseña recién generada (solo tras crear o restablecer el buzón). */
  passwordRecienGenerada?: string;
  /** Abre «Reiniciar configuración» (desde la ficha del buzón). */
  onReiniciar?: () => void;
}

const VALIDECES = [
  { horas: 24, texto: '1 día' },
  { horas: 72, texto: '3 días' },
  { horas: 168, texto: '7 días' },
  { horas: 720, texto: '30 días' },
];

export function ConectarBuzon({ mailboxId, email, passwordRecienGenerada, onReiniciar }: ConectarBuzonProps) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [validez, setValidez] = useState('72');
  const [incluirContrasena, setIncluirContrasena] = useState(false);
  const [creado, setCreado] = useState<EnlaceCreado | null>(null);
  const [aRevocar, setARevocar] = useState<string | null>(null);
  const [descargando, setDescargando] = useState(false);
  const [errorPerfil, setErrorPerfil] = useState('');

  const conexion = useQuery({
    queryKey: ['conexion', mailboxId],
    queryFn: () => api.get<DatosConexion>(`/api/mailboxes/${mailboxId}/connection`),
  });
  const enlaces = useQuery({
    queryKey: ['setup-links', mailboxId],
    queryFn: () => api.get<{ links: EnlaceConfiguracion[] }>(`/api/mailboxes/${mailboxId}/setup-links`),
  });

  const crear = useMutation({
    mutationFn: () => {
      const conContrasena = incluirContrasena && Boolean(passwordRecienGenerada);
      return api.post<{ link: EnlaceCreado }>(`/api/mailboxes/${mailboxId}/setup-links`, {
        ttlHours: Number(validez),
        includePassword: conContrasena,
        password: conContrasena ? passwordRecienGenerada : undefined,
      });
    },
    onSuccess: async (data) => {
      setCreado(data.link);
      await queryClient.invalidateQueries({ queryKey: ['setup-links', mailboxId] });
    },
  });

  // Volver a enviar un enlace activo es solo de la administración: el
  // servidor guarda su token cifrado y solo se lo devuelve a ella.
  const esAdmin = useUsuario()?.role === 'admin';
  const arriba = useRef<HTMLDivElement>(null);
  const recuperar = useMutation({
    mutationFn: (linkId: string) =>
      api.get<{ link: EnlaceCreado }>(`/api/mailboxes/${mailboxId}/setup-links/${linkId}/url`),
    onSuccess: (data) => {
      setCreado(data.link);
      // Se muestra arriba, donde está «Enviar al titular»: sin esto, en el
      // móvil quedaría fuera de la vista.
      arriba.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    onError: (err) => toast('error', mensajeError(err, 'No se ha podido recuperar el enlace.')),
  });

  const revocar = useMutation({
    mutationFn: (linkId: string) => api.delete(`/api/mailboxes/${mailboxId}/setup-links/${linkId}`),
    onSuccess: async (_data, linkId) => {
      setARevocar(null);
      if (creado?.id === linkId) setCreado(null);
      toast('ok', 'Se ha revocado el enlace de configuración.');
      await queryClient.invalidateQueries({ queryKey: ['setup-links', mailboxId] });
    },
    onError: (err) => toast('error', mensajeError(err, 'No se ha podido revocar el enlace.')),
  });

  async function descargarPerfil() {
    setDescargando(true);
    setErrorPerfil('');
    try {
      await descargarFichero(`/api/mailboxes/${mailboxId}/mobileconfig`, `correo-${email}.mobileconfig`);
    } catch (err) {
      setErrorPerfil(mensajeError(err, 'No se ha podido descargar el perfil.'));
    } finally {
      setDescargando(false);
    }
  }

  function enviar(e: FormEvent) {
    e.preventDefault();
    crear.mutate();
  }

  const lista = enlaces.data?.links ?? [];

  return (
    <div ref={arriba} className="flex flex-col gap-6">
      {/* 1. Lo que más ahorra: que el titular lo configure solo. */}
      <Seccion titulo="Enviar al titular">
        <p className="text-base text-tinta-2">
          Crea un enlace con las instrucciones para configurar <span className="valor break-words">{email}</span> en el
          móvil o en el ordenador. El titular no necesita cuenta en el panel.
        </p>

        {creado ? (
          <EnlaceListo email={email} enlace={creado} recuperable={esAdmin}>
            <Button variant="plano" onClick={() => setCreado(null)}>
              Crear otro enlace
            </Button>
          </EnlaceListo>
        ) : (
          <form onSubmit={enviar} className="flex flex-col gap-3">
            <Select label="Validez del enlace" value={validez} onChange={(e) => setValidez(e.target.value)}>
              {VALIDECES.map((v) => (
                <option key={v.horas} value={String(v.horas)}>
                  {v.texto}
                </option>
              ))}
            </Select>
            {!passwordRecienGenerada && (
              // La contraseña no se guarda en claro: solo se puede incluir la
              // que se acaba de generar. Se dice, en lugar de ocultar la opción.
              <p className="text-sm text-tinta-3">
                Para incluir la contraseña en el enlace, restablécela desde la ficha del buzón: solo se puede
                incluir justo después de generarla.
              </p>
            )}
            {passwordRecienGenerada && (
              <label className="flex items-start gap-2.5 text-base text-tinta">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 shrink-0"
                  checked={incluirContrasena}
                  onChange={(e) => setIncluirContrasena(e.target.checked)}
                />
                <span>
                  Incluir la contraseña
                  <span className="mt-0.5 block text-sm text-tinta-2">
                    Así el titular no tendrá que escribirla. Se borra del enlace cuando caduca, cuando se revoca o
                    cuando el titular lo marca como configurado.
                  </span>
                </span>
              </label>
            )}
            {crear.isError && (
              <AvisoError>{mensajeError(crear.error, 'No se ha podido crear el enlace de configuración.')}</AvisoError>
            )}
            <Button type="submit" variant="principal" busy={crear.isPending} className="self-start">
              Crear enlace de configuración
            </Button>
          </form>
        )}
        {onReiniciar && (
          // Lo habitual es probar el buzón antes de entregarlo: se recuerda
          // aquí, donde se crea el enlace, que se puede empezar de cero.
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-regla pt-3">
            <p className="min-w-0 flex-1 basis-56 text-sm text-tinta-2">
              ¿Has probado el buzón antes de entregarlo? Reinícialo para que el titular empiece de cero.
            </p>
            <Button variant="perfil" onClick={onReiniciar}>
              Reiniciar configuración
            </Button>
          </div>
        )}
      </Seccion>

      {/* 2. Para quien prefiere configurarlo en persona. */}
      <Seccion titulo="Datos de conexión">
        {conexion.isPending ? (
          <Cargando label="Cargando datos de conexión…" />
        ) : conexion.isError ? (
          <AvisoError>{mensajeError(conexion.error, 'No se han podido cargar los datos de conexión.')}</AvisoError>
        ) : (
          <>
            <DatosManuales
              email={email}
              usuario={conexion.data.username || undefined}
              conexion={conexion.data}
              notaContrasena="La del buzón, o una contraseña de aplicación."
              compacto
            />
            <div className="flex flex-wrap gap-2">
              <Button variant="perfil" busy={descargando} onClick={() => void descargarPerfil()}>
                Descargar perfil (iPhone/Mac)
              </Button>
              {conexion.data.webmailUrl && (
                <a
                  href={conexion.data.webmailUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={claseEnlaceBoton('perfil', 'panel')}
                >
                  Abrir el correo web
                </a>
              )}
            </div>
            {errorPerfil && <AvisoError>{errorPerfil}</AvisoError>}
            <p className="text-sm text-tinta-3">
              El perfil no incluye la contraseña: el iPhone o el Mac la solicitan al instalarlo.
            </p>
          </>
        )}
      </Seccion>

      {/* 3. Historial: saber si el titular lo abrió y poder retirarlo. */}
      <Seccion titulo="Enlaces creados">
        {enlaces.isPending ? (
          <Cargando label="Cargando enlaces…" />
        ) : enlaces.isError ? (
          <AvisoError>{mensajeError(enlaces.error, 'No se han podido cargar los enlaces.')}</AvisoError>
        ) : lista.length === 0 ? (
          <p className="text-sm text-tinta-3">Aún no se ha creado ningún enlace para este buzón.</p>
        ) : (
          <div className="border border-regla">
            {lista.map((enlace) => {
              const estado = estadoEnlace(enlace);
              return (
                <div
                  key={enlace.id}
                  className="regla-fila flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0 grow basis-full sm:basis-0">
                    <p className="text-base text-tinta">
                      Creado el <span className="valor text-sm">{formatDate(enlace.createdAt)}</span>
                    </p>
                    <p className="text-sm text-tinta-3">
                      {estado === 'activo'
                        ? `Caduca el ${formatDate(enlace.expiresAt)}`
                        : estado === 'revocado'
                          ? `Revocado el ${formatDate(enlace.revokedAt)}`
                          : `Caducó el ${formatDate(enlace.expiresAt)}`}{' '}
                      ·{' '}
                      {enlace.lastOpenedAt ? `Abierto el ${formatDate(enlace.lastOpenedAt)}` : 'Sin abrir'}
                      {enlace.hasPassword && ' · Con contraseña'}
                    </p>
                  </div>
                  <div className="shrink-0">
                    {estado === 'activo' ? (
                      <MarcaFondo veredicto="normal">Activo</MarcaFondo>
                    ) : (
                      <MarcaFondo veredicto="sin-dato">{estado === 'revocado' ? 'Revocado' : 'Caducado'}</MarcaFondo>
                    )}
                  </div>
                  {estado === 'activo' && (
                    <div className="flex shrink-0 flex-wrap items-center gap-1">
                      {aRevocar === enlace.id ? (
                        <>
                          <Button
                            variant="peligro"
                            busy={revocar.isPending}
                            onClick={() => revocar.mutate(enlace.id)}
                          >
                            Confirmar
                          </Button>
                          <Button variant="plano" onClick={() => setARevocar(null)}>
                            Cancelar
                          </Button>
                        </>
                      ) : (
                        <>
                          {esAdmin && enlace.recoverable && (
                            <Button
                              variant="perfil"
                              className="px-2"
                              busy={recuperar.isPending && recuperar.variables === enlace.id}
                              onClick={() => recuperar.mutate(enlace.id)}
                            >
                              Volver a enviar
                            </Button>
                          )}
                          <Button variant="plano" className="px-2" onClick={() => setARevocar(enlace.id)}>
                            Revocar
                          </Button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Seccion>
    </div>
  );
}

/**
 * Enlace de configuración listo para entregar: URL para copiar, QR para el
 * móvil y correo preparado. Para un cliente solo existe en la respuesta que lo
 * crea; la administración puede volver a verlo mientras siga activo, y la
 * nota lo dice.
 */
export function EnlaceListo({
  email,
  enlace,
  recuperable = false,
  children,
}: {
  email: string;
  enlace: EnlaceCreado;
  /** Quien lo ve puede recuperarlo después (administración). */
  recuperable?: boolean;
  /** Acciones adicionales junto a «Enviar por correo». */
  children?: ReactNode;
}) {
  return (
    <div className="revelar flex flex-col gap-3">
      <Muestra rotulo="Enlace de configuración" copiar={enlace.url}>
        <p className="valor break-all text-sm text-tinta">{enlace.url}</p>
      </Muestra>
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
        <QR texto={enlace.url} tamano={148} etiqueta={`Código QR del enlace de configuración de ${email}`} />
        <div className="flex flex-col gap-1.5 text-sm text-tinta-2">
          <p>El titular puede escanear este código con la cámara del móvil.</p>
          <p>Válido hasta el {fechaLarga(enlace.expiresAt)}.</p>
          {enlace.hasPassword && (
            <p>Incluye la contraseña del buzón: envíalo solo al titular, preferiblemente por un canal privado.</p>
          )}
          <p>
            {recuperable
              ? 'Mientras siga activo, puedes volver a enviarlo desde «Enlaces creados».'
              : 'El enlace solo se muestra ahora; si lo pierdes, crea otro.'}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <a href={mailtoEnlace({ email, ...enlace })} className={claseEnlaceBoton('perfil', 'panel')}>
          Enviar por correo
        </a>
        {children}
      </div>
    </div>
  );
}

function estadoEnlace(enlace: EnlaceConfiguracion): 'activo' | 'caducado' | 'revocado' {
  if (enlace.revokedAt) return 'revocado';
  if (enlace.expiresAt <= Date.now()) return 'caducado';
  return 'activo';
}

function Seccion({ titulo, children }: { titulo: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="regla-cabecera pb-2 text-md font-semibold text-tinta">
        {titulo}
      </h3>
      {children}
    </section>
  );
}
