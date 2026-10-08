import type { Ref } from 'react';
import { Link } from 'react-router-dom';
import { nombreVisible } from '../../lib/cloudflare';
import { Button, estiloBoton } from '../../ui/Button';
import { Hoja } from '../../ui/kit';
import { PASOS, type PasoId } from './comun';
import { CabeceraPaso, FilaEstado, PieDePaso, type ContextoPuesta, type EstadoPaso } from './marco';

const enlace = 'text-petroleo underline underline-offset-2 hover:text-tinta';

export function PasoListo({
  ctx,
  estados,
  tituloRef,
}: {
  ctx: ContextoPuesta;
  estados: Record<PasoId, EstadoPaso>;
  tituloRef: Ref<HTMLHeadingElement>;
}) {
  const dominio = ctx.dominio;
  const dnsActivo = dominio?.status === 'active';
  const pendientes = PASOS.filter((p) => p.id !== 'listo' && !estados[p.id].hecho);
  // El DNS incompleto no impide seguir, pero sin él no llega el correo: cuenta como pendiente.
  const todo = pendientes.length === 0 && dnsActivo;

  const revisar = (paso: PasoId, texto = 'Revisar') => (
    <Button variant="perfil" onClick={() => ctx.irA(paso)}>
      {texto}
    </Button>
  );

  return (
    <>
      <CabeceraPaso ref={tituloRef} titulo={todo ? 'Tu correo está en marcha' : 'Falta poco'}>
        {todo
          ? 'Todo lo esencial está configurado. A partir de aquí, tu panel te avisa si algo necesita atención.'
          : 'Ya tienes buena parte hecha. Esto es lo que queda; puedes terminarlo ahora o cuando quieras desde tu panel.'}
      </CabeceraPaso>

      <Hoja title="Resumen" flush>
        <FilaEstado
          concepto={
            dominio ? (
              <>
                Dominio <span className="valor break-all font-medium">{nombreVisible(dominio)}</span>
              </>
            ) : (
              'Dominio'
            )
          }
          veredicto={!dominio ? 'vigilar' : dnsActivo ? 'normal' : 'vigilar'}
          estado={!dominio ? 'Sin añadir' : dnsActivo ? 'Envía y recibe correo' : estados.dominio.detalle}
          nota={
            !dominio
              ? undefined
              : dnsActivo
                ? undefined
                : estados.dominio.hecho
                  ? 'Faltan registros del DNS: hasta que estén todos, el correo no llega ni sale.'
                  : 'Falta comprobar que el dominio es tuyo.'
          }
          accion={!dnsActivo ? revisar('dominio') : undefined}
        />
        <FilaEstado
          concepto="Buzones del equipo"
          veredicto={ctx.buzones.length === 0 ? 'vigilar' : estados.equipo.veredicto}
          estado={estados.equipo.detalle}
          nota={
            ctx.buzones.length === 0
              ? 'Crea al menos uno para empezar a usar el correo.'
              : estados.equipo.veredicto === 'fuera'
                ? 'A alguien aún no le ha llegado su configuración: envíasela por correo o copia su enlace.'
                : estados.equipo.veredicto === 'vigilar'
                  ? 'Hay personas con la configuración enviada que aún no la han terminado.'
                  : undefined
          }
          accion={
            ctx.buzones.length === 0
              ? revisar('equipo', 'Crear buzones')
              : estados.equipo.veredicto !== 'normal'
                ? revisar('equipo')
                : undefined
          }
        />
        <FilaEstado
          concepto="postmaster@ y abuse@"
          veredicto={estados.obligatorias.hecho ? 'normal' : 'vigilar'}
          estado={estados.obligatorias.detalle}
          accion={!estados.obligatorias.hecho ? revisar('obligatorias', 'Crearlas') : undefined}
        />
        <FilaEstado
          concepto="Tus dispositivos"
          veredicto={estados.dispositivos.veredicto}
          estado={estados.dispositivos.detalle}
          accion={!estados.dispositivos.hecho ? revisar('dispositivos', 'Configurar') : undefined}
        />
      </Hoja>

      <Hoja title="Cuando lo necesites">
        <ul className="flex flex-col gap-2.5 text-base text-tinta-2">
          <li className="max-w-[68ch]">
            <span className="font-medium text-tinta">Más personas:</span> pulsa «Añadir buzones» arriba en esta
            página o ve a{' '}
            <Link to="/buzones" className={enlace}>
              Buzones
            </Link>
            . Después, envía a cada una su configuración desde «Tu equipo».
          </li>
          <li className="max-w-[68ch]">
            <span className="font-medium text-tinta">Direcciones compartidas</span> como info@ o ventas@: créalas como{' '}
            <Link to="/alias" className={enlace}>
              alias
            </Link>{' '}
            que reenvían a quien las atiende.
          </li>
          <li className="max-w-[68ch]">
            <span className="font-medium text-tinta">Correo automático</span> desde tu web o tus aplicaciones (avisos,
            facturas, códigos de acceso): crea una clave en{' '}
            <Link to="/api-envio" className={enlace}>
              API de envío
            </Link>
            .
          </li>
        </ul>
      </Hoja>

      <PieDePaso
        atras="Tus dispositivos"
        onAtras={() => ctx.irA('dispositivos')}
        principal={
          <Link to="/" className={estiloBoton('principal')}>
            Ir a tu panel
          </Link>
        }
      />
    </>
  );
}
