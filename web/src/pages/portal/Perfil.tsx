import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { mensajeError } from '../../lib/portal';
import { FotoBuzon } from '../../components/FotoBuzon';
import { Button } from '../../ui/Button';
import { Input } from '../../ui/Field';
import { Hoja } from '../../ui/kit';
import { AvisoError, AvisoHecho, TACTIL } from './comun';

/** Máximo del servidor para el nombre visible. */
const MAXIMO_NOMBRE = 80;

/**
 * «Tu perfil»: nombre visible y foto del titular. La comparten la página del
 * enlace de configuración y «Mi buzón»; cada una pasa sus rutas y qué volver
 * a pedir después (el nombre va dentro del perfil de Apple y del QR de
 * Thunderbird, que el servidor genera con el nombre guardado).
 */
export function HojaPerfil({
  displayName,
  fotoUrl,
  urlPerfil,
  urlFoto,
  explicacion,
  onCambio,
}: {
  displayName: string;
  fotoUrl: string | null;
  /** PATCH { displayName } → { displayName } */
  urlPerfil: string;
  /** PUT { photo } y DELETE */
  urlFoto: string;
  explicacion: ReactNode;
  /** Recarga los datos de la página tras cambiar el nombre o la foto. */
  onCambio: () => Promise<unknown>;
}) {
  const [nombre, setNombre] = useState(displayName);
  const [guardado, setGuardado] = useState<string | null>(null);

  const guardar = useMutation({
    mutationFn: () => api.patch<{ displayName: string }>(urlPerfil, { displayName: nombre.trim() }),
    onSuccess: async (data) => {
      // El servidor recorta los espacios: el campo muestra lo que se guardó.
      setNombre(data.displayName);
      setGuardado(data.displayName);
      await onCambio();
    },
  });

  const sinCambios = nombre.trim() === displayName;

  function enviar(e: FormEvent) {
    e.preventDefault();
    if (sinCambios || guardar.isPending) return;
    setGuardado(null);
    guardar.mutate();
  }

  return (
    <Hoja title="Tu perfil">
      <div className="flex flex-col gap-4">
        <div className="max-w-[70ch] text-base text-tinta-2">{explicacion}</div>
        <form onSubmit={enviar} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="grow">
            <Input
              label="Tu nombre"
              autoComplete="name"
              autoCapitalize="words"
              maxLength={MAXIMO_NOMBRE}
              placeholder="Por ejemplo: Ana García"
              value={nombre}
              onChange={(e) => {
                guardar.reset();
                setGuardado(null);
                setNombre(e.target.value);
              }}
              className={TACTIL}
            />
          </div>
          <Button
            type="submit"
            variant="perfil"
            busy={guardar.isPending}
            disabled={sinCambios}
            className={`${TACTIL} self-stretch sm:self-auto`}
          >
            Guardar
          </Button>
        </form>
        {guardado !== null && (
          <AvisoHecho>
            {guardado
              ? 'Se ha guardado tu nombre.'
              : 'Se ha quitado tu nombre: quienes reciban tus correos solo verán tu dirección.'}
          </AvisoHecho>
        )}
        {guardar.isError && (
          <AvisoError>{mensajeError(guardar.error, 'No se ha podido guardar tu nombre.')}</AvisoError>
        )}
        <div className="border-t border-regla pt-4">
          <FotoBuzon
            fotoUrl={fotoUrl}
            url={urlFoto}
            tactil
            rotulo="Tu foto"
            ayuda="Se recorta en cuadrado. La verán las personas de tu organización en el correo web."
            onCambio={onCambio}
          />
        </div>
      </div>
    </Hoja>
  );
}
