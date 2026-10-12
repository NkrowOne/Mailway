import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { mensajeCambio, type CambioDominioVista } from '../../lib/cambioDominio';
import { descargarFichero } from '../../lib/portal';
import { Button } from '../../ui/Button';
import { AvisoError, BotonCopiar, Cargando } from '../../ui/kit';
import { useToast } from '../../ui/toast';

/*
  Modo guiado (dominio nuevo sin zona en Cloudflare): los registros que hay
  que crear en el proveedor de DNS, con «Copiar todo» y el fichero de zona.
  Salen de las rutas de siempre del dominio (GET /api/domains/:id/dns y
  /zonefile) para que la ficha del dominio y el asistente digan lo mismo.

  Si el dominio nuevo ya recibe correo en otro proveedor, el MX va aparte y
  solo se ofrece cuando ya recibe en los buzones de aquí: cambiarlo antes
  dejaría sin destino el correo que llegue.
*/

interface RegistroDns {
  type: string;
  name: string;
  content: string;
  required: boolean;
  category: 'obligatorio' | 'autoconfiguracion' | 'verificacion' | 'endurecimiento';
}

interface RespuestaDns {
  records: RegistroDns[];
  mxInternos: string[];
}

/** Nombres sin el punto final, como los escribe cualquier panel de DNS. */
function sinPunto(nombre: string): string {
  return nombre.replace(/\.$/, '');
}

/** Una línea por registro, para pegar en una nota o enviar a quien gestione el DNS. */
function textoRegistros(registros: RegistroDns[]): string {
  return registros.map((r) => `${r.type}\t${sinPunto(r.name)}\t${r.content}`).join('\n');
}

export function RegistrosDns({ vista }: { vista: CambioDominioVista }) {
  const toast = useToast();
  const toId = vista.hacia.domainId;
  const dominio = vista.hacia.domain;
  const consulta = useQuery({
    queryKey: ['domain-dns', toId],
    queryFn: () => api.get<RespuestaDns>(`/api/domains/${encodeURIComponent(toId ?? '')}/dns`),
    enabled: Boolean(toId),
  });
  const descarga = useMutation({
    mutationFn: () =>
      descargarFichero(
        `/api/domains/${encodeURIComponent(toId ?? '')}/zonefile?nivel=recomendados`,
        `${dominio}-mailway-recomendados.txt`,
      ),
    onError: (err) => toast('error', mensajeCambio(err, 'No se ha podido descargar el fichero de zona.')),
  });

  if (!toId) return null;
  if (consulta.isPending) return <Cargando label={`Cargando los registros de ${dominio}…`} />;
  if (consulta.isError) {
    return (
      <AvisoError onRetry={() => void consulta.refetch()} retrying={consulta.isFetching}>
        {mensajeCambio(consulta.error, `No se han podido cargar los registros DNS de ${dominio}.`)}
      </AvisoError>
    );
  }

  // MTA-STS y TLS-RPT exigen publicar una política en la web: no son parte del cambio.
  const utiles = consulta.data.records.filter((r) => r.category !== 'endurecimiento');
  const mxAparte = vista.hacia.recibeEnOtroProveedor;
  const esMx = (r: RegistroDns) => r.type.toUpperCase() === 'MX';
  const principales = mxAparte ? utiles.filter((r) => !esMx(r)) : utiles;
  const mx = mxAparte ? utiles.filter(esMx) : [];
  const mxInterno = consulta.data.mxInternos.length > 0;
  // El fichero incluye el MX: importarlo antes de tiempo cambiaría el proveedor.
  const zonaRetenida = mxAparte && !vista.recepcionPreparada;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="min-w-0 flex-1 basis-60 text-base text-tinta-2">Añade estos registros en tu proveedor de DNS</p>
        <div className="flex flex-wrap gap-2">
          <BotonCopiar text={textoRegistros(principales)} label="Copiar todo" />
          <Button
            variant="perfil"
            className="!h-7 px-2 text-sm"
            busy={descarga.isPending}
            disabled={zonaRetenida || mxInterno}
            onClick={() => descarga.mutate()}
          >
            Descargar fichero de zona
          </Button>
        </div>
      </div>
      {mxInterno && (
        <AvisoError>
          El servidor de correo anuncia un MX interno para {dominio}: revisa la ficha del dominio antes de crear los
          registros.
        </AvisoError>
      )}
      {zonaRetenida && (
        <p className="max-w-[75ch] text-sm text-tinta-3">
          El fichero de zona incluye el MX: descárgalo cuando {dominio} ya reciba en los buzones.
        </p>
      )}

      <ListaRegistros registros={principales} />

      {mxAparte && mx.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="rotulo [overflow-wrap:anywhere]">Cuando veas «{dominio} ya recibe en los buzones», cambia el MX:</p>
          {!vista.recepcionPreparada && (
            <p className="max-w-[75ch] text-sm text-tinta-3">
              Todavía no: el correo de {dominio} sigue llegando a su proveedor actual.
            </p>
          )}
          <ListaRegistros registros={mx} copiable={vista.recepcionPreparada} />
        </div>
      )}
    </div>
  );
}

function ListaRegistros({ registros, copiable = true }: { registros: RegistroDns[]; copiable?: boolean }) {
  return (
    <ul className={`rounded-lg border border-regla bg-hoja-2 ${copiable ? '' : 'opacity-60'}`}>
      {registros.map((r) => (
        <li
          key={`${r.type}:${r.name}:${r.content}`}
          className="regla-fila flex flex-wrap items-start gap-x-3 gap-y-1.5 px-3 py-2.5 last:border-b-0"
        >
          <span className="rotulo w-14 shrink-0 pt-0.5">{r.type}</span>
          <div className="min-w-0 flex-1 basis-48">
            <p className="codigo break-all text-sm text-tinta">{sinPunto(r.name)}</p>
            <p className="codigo break-all text-sm text-tinta-2">{r.content}</p>
          </div>
          {copiable && <BotonCopiar text={r.content} />}
        </li>
      ))}
    </ul>
  );
}
