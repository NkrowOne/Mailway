<?php

/*
 * Datos del complemento mailway_cuentas: lo que toca la base de Roundcube.
 *
 * Sin estado (solo métodos estáticos) para poder probarlo con la biblioteca y
 * el esquema reales de la imagen sin montar un webmail entero
 * (deploy/roundcube/pruebas/mailway_cuentas.php).
 *
 * Regla de oro: NUNCA se borra nada. Una fila de users que estorba se aparta
 * renombrándola («<usuario>#apartado-<user_id>») y conserva sus contactos,
 * identidades y preferencias por si hay que recuperarla a mano.
 */
class mailway_cuentas_datos
{
    /** Sufijo con el que se aparta la fila que ocupaba el usuario vigente. */
    public const APARTADO = '#apartado-';

    /** Longitud de users.username en el esquema de Roundcube. */
    private const MAX_USUARIO = 128;

    /**
     * Respuesta de POST /api/webmail/cuenta, validada y en minúsculas. null si
     * no tiene la forma esperada: entonces se entra como siempre, sin traducir.
     *
     * @return array{login: string, email: string, anteriores: string[], otrasDirecciones: string[]}|null
     */
    public static function validarRespuesta($datos): ?array
    {
        if (!is_array($datos)) {
            return null;
        }
        $login = self::direccion($datos['login'] ?? null);
        $email = self::direccion($datos['email'] ?? null);
        if ($login === null || $email === null) {
            return null;
        }

        return [
            'login' => $login,
            'email' => $email,
            'anteriores' => self::lista($datos['anteriores'] ?? []),
            'otrasDirecciones' => self::lista($datos['otrasDirecciones'] ?? []),
        ];
    }

    /**
     * mail_host con el que rcmail::login guarda la fila de users: el nombre del
     * servidor IMAP sin esquema ni puerto y en ASCII. Con el mismo cálculo que
     * Roundcube (program/include/rcmail.php, login()), la fila que se traslada
     * es exactamente la que después encuentra rcube_user::query().
     *
     * @param mixed $host     Host elegido en el formulario (autoselect_host()), o vacío
     * @param mixed $imapHost Valor de imap_host en la configuración
     */
    public static function hostDeAlmacen($host, $imapHost): string
    {
        if (empty($host)) {
            if (is_array($imapHost)) {
                $clave = key($imapHost);
                $host = is_numeric($clave) ? $imapHost[$clave] : $clave;
            } else {
                $host = $imapHost;
            }
        }
        $host = rcube_utils::parse_host((string) $host);
        if (!is_string($host) || $host === '') {
            return '';
        }
        [$nombre] = rcube_utils::parse_host_uri($host, 143, 993);

        return (string) rcube_utils::idn_to_ascii((string) $nombre);
    }

    /**
     * Traslada la fila de users de un usuario anterior al vigente, en una
     * transacción y sin borrar nunca:
     *
     * 1. Si no hay fila de ningún «anterior»: 'sin_cambios' (también al repetir).
     * 2. Si ya hay fila del usuario vigente (alguien entró antes con él), se
     *    aparta: username = '<login>#apartado-<user_id>'.
     * 3. La fila del primer anterior que exista pasa a llamarse <login>: el
     *    user_id no cambia, así que sus contactos, identidades, respuestas y
     *    preferencias siguen con ella.
     *
     * @param string[] $anteriores
     *
     * @return string 'sin_cambios' | 'trasladada' | 'trasladada_apartando'
     */
    public static function trasladarFila(rcube_db $db, string $host, string $login, array $anteriores): string
    {
        $login = mb_strtolower(trim($login));
        $candidatos = array_values(array_filter(
            self::lista($anteriores),
            static fn (string $anterior): bool => $anterior !== $login,
        ));
        if ($host === '' || $login === '' || !$candidatos) {
            return 'sin_cambios';
        }

        $tabla = $db->table_name('users', true);
        if (!$db->startTransaction()) {
            throw new RuntimeException('no se ha podido abrir la transacción: ' . ($db->is_error() ?: 'sin detalle'));
        }
        try {
            $origen = null;
            foreach ($candidatos as $anterior) {
                $origen = self::fila($db, $tabla, $host, $anterior);
                if ($origen !== null) {
                    break;
                }
            }
            if ($origen === null) {
                $db->rollbackTransaction();

                return 'sin_cambios';
            }

            $resultado = 'trasladada';
            $vigente = self::fila($db, $tabla, $host, $login);
            if ($vigente !== null) {
                self::ejecutar(
                    $db,
                    "UPDATE {$tabla} SET `username` = ? WHERE `user_id` = ?",
                    self::nombreApartado($login, (int) $vigente['user_id']),
                    $vigente['user_id'],
                );
                $resultado = 'trasladada_apartando';
            }
            self::ejecutar($db, "UPDATE {$tabla} SET `username` = ? WHERE `user_id` = ?", $login, $origen['user_id']);

            if (!$db->endTransaction()) {
                throw new RuntimeException('no se ha podido confirmar la transacción: ' . ($db->is_error() ?: 'sin detalle'));
            }

            return $resultado;
        } catch (Throwable $e) {
            $db->rollbackTransaction();

            throw $e;
        }
    }

    /**
     * Pasa a la dirección vigente la identidad que aún tiene una dirección
     * anterior del buzón: la predeterminada si es una de ellas y, si no, la
     * primera que lo sea. Solo cambia el campo email: nombre, organización,
     * firmas, responder a y CCO se conservan. Si alguna identidad usa ya la
     * dirección vigente, no toca nada (así es idempotente y respeta lo que el
     * titular haya configurado).
     *
     * @param string[] $otras
     *
     * @return bool true si cambió algo
     */
    public static function actualizarIdentidades(rcube_user $user, string $email, array $otras): bool
    {
        $email = mb_strtolower(trim($email));
        $otras = array_values(array_filter(
            self::lista($otras),
            static fn (string $otra): bool => $otra !== $email,
        ));
        if ($email === '' || !$otras || !$user->ID) {
            return false;
        }
        // Ordenadas con la predeterminada primero (rcube_user::list_identities).
        $identidades = $user->list_identities();
        foreach ($identidades as $identidad) {
            if (mb_strtolower(trim((string) $identidad['email'])) === $email) {
                return false;
            }
        }
        foreach ($identidades as $identidad) {
            if (in_array(mb_strtolower(trim((string) $identidad['email'])), $otras, true)) {
                return (bool) $user->update_identity($identidad['identity_id'], ['email' => $email]);
            }
        }

        return false;
    }

    /* ------------------------------- Internos ------------------------------- */

    /** Dirección o usuario válido (algo@algo), en minúsculas; null si no lo es. */
    private static function direccion($valor): ?string
    {
        if (!is_string($valor)) {
            return null;
        }
        $valor = mb_strtolower(trim($valor));
        $arroba = strrpos($valor, '@');
        if ($valor === '' || strlen($valor) > 320 || $arroba === false || $arroba === 0
            || $arroba === strlen($valor) - 1 || preg_match('/[\s\x00-\x1F\x7F]/', $valor)) {
            return null;
        }

        return $valor;
    }

    /**
     * @return string[] Direcciones válidas, sin repetir y en su orden
     */
    private static function lista($valores): array
    {
        if (!is_array($valores)) {
            return [];
        }
        $salida = [];
        foreach ($valores as $valor) {
            $direccion = self::direccion($valor);
            if ($direccion !== null && !in_array($direccion, $salida, true)) {
                $salida[] = $direccion;
            }
        }

        return $salida;
    }

    private static function fila(rcube_db $db, string $tabla, string $host, string $usuario): ?array
    {
        $resultado = $db->query(
            "SELECT `user_id`, `username` FROM {$tabla} WHERE `mail_host` = ? AND `username` = ?",
            $host,
            $usuario,
        );
        if ($resultado === false) {
            throw new RuntimeException('no se ha podido leer la tabla users: ' . ($db->is_error() ?: 'sin detalle'));
        }
        $fila = $db->fetch_assoc($resultado);

        return is_array($fila) && $fila ? $fila : null;
    }

    private static function ejecutar(rcube_db $db, string $sql, ...$parametros): void
    {
        $resultado = $db->query($sql, ...$parametros);
        if ($resultado === false || $db->affected_rows($resultado) !== 1) {
            throw new RuntimeException('no se ha podido actualizar la tabla users: ' . ($db->is_error() ?: 'ninguna fila afectada'));
        }
    }

    /** '<login>#apartado-<id>', recortando el login para no pasar de users.username. */
    private static function nombreApartado(string $login, int $userId): string
    {
        $sufijo = self::APARTADO . $userId;

        return mb_strcut($login, 0, self::MAX_USUARIO - strlen($sufijo), 'UTF-8') . $sufijo;
    }
}
