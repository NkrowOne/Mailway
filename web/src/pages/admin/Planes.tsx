import { useState, type FormEvent } from 'react';
import { ClipboardList } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, type Client, type Plan } from '../../lib/api';
import { plural } from '../../lib/format';
import { formatQuota, mensajeDe } from '../../lib/gestion';
import { Button } from '../../ui/Button';
import { Input, Textarea } from '../../ui/Field';
import { Dialogo, Hoja, Membrete, Cargando, Vacio } from '../../ui/kit';
import { useToast } from '../../ui/toast';
import { BandaAviso, BandaError, Botonera } from '../../components/gestion/comun';

type Editor = { modo: 'crear' } | { modo: 'editar'; plan: Plan };

/**
 * Planes: los límites que se asignan a cada cliente (dominios, buzones,
 * alias, cuota por buzón y envíos por API). Tabla reglada con cuántos
 * clientes usan cada plan; un plan en uso no se puede eliminar.
 */
export default function Planes() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [toDelete, setToDelete] = useState<Plan | null>(null);

  const plans = useQuery({
    queryKey: ['plans'],
    queryFn: () => api.get<{ plans: Plan[] }>('/api/plans'),
  });
  const clients = useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/api/clients'),
  });

  const remove = useMutation({
    mutationFn: (plan: Plan) => api.delete(`/api/plans/${plan.id}`),
    onSuccess: async (_data, plan) => {
      await queryClient.invalidateQueries({ queryKey: ['plans'] });
      setToDelete(null);
      toast('ok', `Plan «${plan.name}» eliminado.`);
    },
    onError: (err) => toast('error', mensajeDe(err, 'No se ha podido eliminar el plan.')),
  });

  const list = plans.data?.plans ?? [];
  const clientList = clients.data?.clients ?? [];

  return (
    <>
      <Membrete
        title="Planes"
        meta={
          <>
            <p>
              Límites que se asignan a cada cliente. Un cambio en un plan se aplica a todos los clientes que lo
              usan.
            </p>
            {plans.isSuccess && list.length > 0 && (
              <p className="mt-1 text-sm text-tinta-3">{plural(list.length, 'plan', 'planes')}</p>
            )}
          </>
        }
        actions={
          <Button variant="principal" onClick={() => setEditor({ modo: 'crear' })}>
            Crear plan
          </Button>
        }
      />

      {plans.isPending ? (
        <Hoja flush>
          <Cargando label="Leyendo los planes…" />
        </Hoja>
      ) : plans.isError ? (
        <BandaError onRetry={() => void plans.refetch()}>
          {mensajeDe(plans.error, 'No se han podido cargar los planes.')}
        </BandaError>
      ) : list.length === 0 ? (
        <Hoja flush>
          <Vacio icono={ClipboardList}
            title="No hay planes"
            action={
              <Button variant="perfil" onClick={() => setEditor({ modo: 'crear' })}>
                Crear el primero
              </Button>
            }
          >
            Sin al menos un plan no es posible dar de alta clientes.
          </Vacio>
        </Hoja>
      ) : (
        <Hoja flush>
          <div className="regla-cabecera hidden items-baseline gap-x-4 px-4 py-2 xl:flex">
            <span className="rotulo min-w-0 grow basis-0">Plan</span>
            <span className="rotulo w-16 shrink-0 text-right">Dominios</span>
            <span className="rotulo w-16 shrink-0 text-right">Buzones</span>
            <span className="rotulo w-14 shrink-0 text-right">Alias</span>
            <span className="rotulo w-20 shrink-0 text-right">Cuota</span>
            <span className="rotulo w-24 shrink-0 text-right">API/día</span>
            <span className="rotulo w-16 shrink-0 text-right">API/min</span>
            <span className="rotulo w-16 shrink-0 text-right">Clientes</span>
            <span className="rotulo w-40 shrink-0 text-right">Acciones</span>
          </div>
          {list.map((plan) => (
            <div
              key={plan.id}
              className="regla-fila flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors duration-100
                last:border-b-0 hover:bg-hoja-2"
            >
              <div className="min-w-0 grow basis-full xl:basis-0">
                <p className="break-words text-md font-medium text-tinta">{plan.name}</p>
                {plan.notes && <p className="break-words text-sm text-tinta-3">{plan.notes}</p>}
              </div>
              <Celda rotulo="Dominios" ancho="xl:w-16" valor={plan.maxDomains} />
              <Celda rotulo="Buzones" ancho="xl:w-16" valor={plan.maxMailboxes} />
              <Celda rotulo="Alias" ancho="xl:w-14" valor={plan.maxAliases} />
              <Celda rotulo="Cuota" ancho="xl:w-20" valor={formatQuota(plan.mailboxQuotaMb)} />
              <Celda
                rotulo="API/día"
                ancho="xl:w-24"
                valor={plan.apiDailyLimit === 0 ? 'Sin límite' : plan.apiDailyLimit.toLocaleString('es-ES')}
              />
              <Celda rotulo="API/min" ancho="xl:w-16" valor={plan.apiPerMinuteLimit} />
              <Celda rotulo="Clientes" ancho="xl:w-16" valor={plan.clientCount ?? '—'} />
              <div className="flex w-full justify-end gap-1 xl:w-40">
                <Button variant="perfil" className="px-2" onClick={() => setEditor({ modo: 'editar', plan })}>
                  Editar
                </Button>
                <Button variant="peligro" className="px-2" onClick={() => setToDelete(plan)}>
                  Eliminar
                </Button>
              </div>
            </div>
          ))}
        </Hoja>
      )}

      {editor && (
        <FormularioPlan
          key={editor.modo === 'editar' ? editor.plan.id : 'nuevo'}
          editor={editor}
          clientes={clientList}
          onClose={() => setEditor(null)}
        />
      )}

      <Dialogo open={toDelete !== null} onClose={() => setToDelete(null)} title="Eliminar plan">
        {toDelete &&
          ((toDelete.clientCount ?? 0) > 0 ? (
            <div className="flex flex-col gap-4">
              <BandaAviso>
                No es posible eliminar el plan «{toDelete.name}»:{' '}
                {toDelete.clientCount === 1 ? 'lo usa 1 cliente' : `lo usan ${toDelete.clientCount} clientes`}.
                Asígnales otro plan desde su ficha en «Clientes» y vuelve a intentarlo.
              </BandaAviso>
              <ul className="border border-regla">
                {clientList
                  .filter((c) => c.planId === toDelete.id)
                  .map((c) => (
                    <li key={c.id} className="regla-fila px-3 py-2 last:border-b-0">
                      <Link to={`/clientes/${c.id}`} className="text-base text-tinta hover:text-petroleo hover:underline">
                        {c.name}
                      </Link>
                    </li>
                  ))}
              </ul>
              <Botonera>
                <Button variant="principal" onClick={() => setToDelete(null)}>
                  Entendido
                </Button>
              </Botonera>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-base text-tinta-2">
                Se eliminará el plan «{toDelete.name}». Ningún cliente lo usa, así que no afecta a nadie.
              </p>
              <Botonera>
                <Button variant="plano" onClick={() => setToDelete(null)}>
                  Cancelar
                </Button>
                <Button variant="peligro" busy={remove.isPending} onClick={() => remove.mutate(toDelete)}>
                  Eliminar plan
                </Button>
              </Botonera>
            </div>
          ))}
      </Dialogo>
    </>
  );
}

function Celda({ rotulo, ancho, valor }: { rotulo: string; ancho: string; valor: string | number }) {
  return (
    <div className={`flex shrink-0 items-baseline gap-1.5 ${ancho} xl:justify-end`}>
      <span className="rotulo xl:hidden">{rotulo}</span>
      <span className="valor text-sm text-tinta">{valor}</span>
    </div>
  );
}

/* ----------------------------- Crear / editar ----------------------------- */

interface Campos {
  name: string;
  notes: string;
  maxDomains: string;
  maxMailboxes: string;
  maxAliases: string;
  mailboxQuotaMb: string;
  apiDailyLimit: string;
  apiPerMinuteLimit: string;
}

/**
 * Rango admitido de cada límite: el mismo que valida el servidor. Se
 * comprueba al guardar con mensajes propios en el campo; los min/max nativos
 * mostraban un globo del navegador, a veces en otro idioma, y ocultaban estos.
 */
const RANGOS: Record<Exclude<keyof Campos, 'name' | 'notes'>, { min: number; max: number }> = {
  maxDomains: { min: 1, max: 1000 },
  maxMailboxes: { min: 1, max: 100000 },
  maxAliases: { min: 0, max: 100000 },
  mailboxQuotaMb: { min: 64, max: 1048576 },
  apiDailyLimit: { min: 0, max: 10000000 },
  apiPerMinuteLimit: { min: 1, max: 100000 },
};

function errorLimite(clave: keyof typeof RANGOS, valor: string): string | undefined {
  const { min, max } = RANGOS[clave];
  const n = Number(valor);
  if (valor.trim() === '' || !Number.isInteger(n)) return 'Indica un número entero.';
  if (n < min || n > max) {
    const formato = (x: number) => x.toLocaleString('es-ES');
    return `Indica un valor entre ${formato(min)} y ${formato(max)}.`;
  }
  return undefined;
}

const porDefecto: Campos = {
  name: '',
  notes: '',
  maxDomains: '1',
  maxMailboxes: '10',
  maxAliases: '20',
  mailboxQuotaMb: '2048',
  apiDailyLimit: '1000',
  apiPerMinuteLimit: '60',
};

function FormularioPlan({ editor, clientes, onClose }: { editor: Editor; clientes: Client[]; onClose: () => void }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const plan = editor.modo === 'editar' ? editor.plan : null;
  const [campos, setCampos] = useState<Campos>(() =>
    plan
      ? {
          name: plan.name,
          notes: plan.notes,
          maxDomains: String(plan.maxDomains),
          maxMailboxes: String(plan.maxMailboxes),
          maxAliases: String(plan.maxAliases),
          mailboxQuotaMb: String(plan.mailboxQuotaMb),
          apiDailyLimit: String(plan.apiDailyLimit),
          apiPerMinuteLimit: String(plan.apiPerMinuteLimit),
        }
      : porDefecto,
  );
  const [error, setError] = useState('');
  const [intentado, setIntentado] = useState(false);
  const set = (clave: keyof Campos) => (e: { target: { value: string } }) => {
    setError('');
    setCampos((prev) => ({ ...prev, [clave]: e.target.value }));
  };
  // Los errores de cada campo se muestran tras el primer intento de guardar.
  const errorCampo = (clave: keyof typeof RANGOS) => (intentado ? errorLimite(clave, campos[clave]) : undefined);
  const n = (clave: keyof Campos) => Number(campos[clave]);

  // Clientes del plan que quedarían por encima de los nuevos límites: se
  // avisa antes de guardar (conservan lo que tienen, pero no crecen).
  const excedidos = plan
    ? clientes.filter(
        (c) =>
          c.planId === plan.id &&
          c.usage &&
          (c.usage.domains > n('maxDomains') || c.usage.mailboxes > n('maxMailboxes') || c.usage.aliases > n('maxAliases')),
      )
    : [];

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: campos.name,
        notes: campos.notes,
        maxDomains: n('maxDomains'),
        maxMailboxes: n('maxMailboxes'),
        maxAliases: n('maxAliases'),
        mailboxQuotaMb: n('mailboxQuotaMb'),
        apiDailyLimit: n('apiDailyLimit'),
        apiPerMinuteLimit: n('apiPerMinuteLimit'),
      };
      return plan ? api.patch(`/api/plans/${plan.id}`, body) : api.post('/api/plans', body);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['plans'] }),
        queryClient.invalidateQueries({ queryKey: ['clients'] }),
        queryClient.invalidateQueries({ queryKey: ['client'] }),
      ]);
      toast('ok', plan ? `Plan «${campos.name}» actualizado.` : `Plan «${campos.name}» creado.`);
      onClose();
    },
    onError: (err) => setError(mensajeDe(err, 'No se ha podido guardar el plan.')),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setIntentado(true);
    if (campos.name.trim().length < 2) {
      setError('El nombre del plan debe tener al menos 2 caracteres.');
      return;
    }
    const conError = (Object.keys(RANGOS) as (keyof typeof RANGOS)[]).filter((k) => errorLimite(k, campos[k]));
    if (conError.length > 0) {
      setError(
        conError.length === 1
          ? 'Revisa el límite marcado.'
          : `Revisa los ${conError.length} límites marcados.`,
      );
      return;
    }
    setError('');
    save.mutate();
  }

  const cuota = n('mailboxQuotaMb');

  return (
    <Dialogo open onClose={onClose} title={plan ? 'Editar plan' : 'Crear plan'}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input
          label="Nombre"
          maxLength={60}
          value={campos.name}
          onChange={set('name')}
          placeholder="Profesional"
          error={intentado && campos.name.trim().length < 2 ? 'Indica un nombre de al menos 2 caracteres.' : undefined}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Dominios"
            type="number"
            inputMode="numeric"
            mono
            value={campos.maxDomains}
            onChange={set('maxDomains')}
            error={errorCampo('maxDomains')}
            help="Máximo de dominios de correo."
          />
          <Input
            label="Buzones"
            type="number"
            inputMode="numeric"
            mono
            value={campos.maxMailboxes}
            onChange={set('maxMailboxes')}
            error={errorCampo('maxMailboxes')}
            help="Máximo de buzones entre todos sus dominios."
          />
          <Input
            label="Alias"
            type="number"
            inputMode="numeric"
            mono
            value={campos.maxAliases}
            onChange={set('maxAliases')}
            error={errorCampo('maxAliases')}
            help="0 = el cliente no puede crear alias."
          />
          <Input
            label="Cuota por buzón (MB)"
            type="number"
            inputMode="numeric"
            mono
            step={1}
            value={campos.mailboxQuotaMb}
            onChange={set('mailboxQuotaMb')}
            error={errorCampo('mailboxQuotaMb')}
            help={
              Number.isInteger(cuota) && cuota >= 64
                ? `Equivale a ${formatQuota(cuota)}. Máximo por buzón; los existentes conservan la suya.`
                : 'Mínimo 64 MB. 1 GB = 1024 MB.'
            }
          />
          <Input
            label="Envíos por API al día"
            type="number"
            inputMode="numeric"
            mono
            value={campos.apiDailyLimit}
            onChange={set('apiDailyLimit')}
            error={errorCampo('apiDailyLimit')}
            help="Por cliente y día. 0 = sin límite diario."
          />
          <Input
            label="Envíos por API por minuto"
            type="number"
            inputMode="numeric"
            mono
            value={campos.apiPerMinuteLimit}
            onChange={set('apiPerMinuteLimit')}
            error={errorCampo('apiPerMinuteLimit')}
            help="Protege la reputación del servidor ante ráfagas."
          />
        </div>
        <Textarea label="Notas (opcional)" maxLength={500} value={campos.notes} onChange={set('notes')} placeholder="Para quién es este plan" />
        {excedidos.length > 0 && (
          <BandaAviso>
            {excedidos.length === 1
              ? `1 cliente supera los nuevos límites (${excedidos[0]!.name}). Conservará lo que ya tiene, pero no podrá crear más dominios, buzones o alias hasta estar por debajo del límite.`
              : `${excedidos.length} clientes superan los nuevos límites (${excedidos.map((c) => c.name).join(', ')}). Conservarán lo que ya tienen, pero no podrán crear más dominios, buzones o alias hasta estar por debajo del límite.`}
          </BandaAviso>
        )}
        {plan && (plan.clientCount ?? 0) > 0 && (
          <p className="text-sm text-tinta-3">
            Los cambios se aplican a {plan.clientCount === 1 ? '1 cliente' : `${plan.clientCount} clientes`}.
          </p>
        )}
        {error && <BandaError>{error}</BandaError>}
        <Botonera>
          <Button type="button" variant="plano" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="principal" busy={save.isPending}>
            {plan ? 'Guardar cambios' : 'Crear plan'}
          </Button>
        </Botonera>
      </form>
    </Dialogo>
  );
}
