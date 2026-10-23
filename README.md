# RASTREADOC

Sistema privado y sencillo para controlar expedientes, sus documentos y el
historial completo de movimientos de una notaría.

## Alcance de la primera versión

La estructura principal será:

**Expediente → Documentos → Movimientos**

- Un expediente se identifica por su número y puede contener varios documentos.
- Cada documento tiene tipo, dependencia, estatus actual y un código QR único.
- Cada cambio crea un movimiento fechado; los movimientos anteriores nunca se
  reemplazan ni se borran.
- El panel permitirá buscar, filtrar, consultar el estado de los documentos y
  abrir un expediente para ver todos sus documentos.
- La pantalla de escaneo mostrará el documento y ofrecerá acciones grandes y
  claras para registrar su siguiente movimiento.

## Tecnología elegida

- **GitHub:** guardará el código y su historial de cambios.
- **Next.js:** construirá la aplicación web y sus pantallas adaptables.
- **Vercel:** publicará automáticamente la aplicación desde GitHub y proporcionará
  la dirección web que usará la oficina.
- **Supabase:** proporcionará PostgreSQL, autenticación y acceso centralizado a
  los datos para que todas las computadoras consulten la misma información.

Esta arquitectura sustituye el prototipo local de Django. La aplicación final no
requerirá Python, Docker ni una base de datos instalada en las computadoras de
los empleados.

## Uso desde varias computadoras

La versión de trabajo se publicará como una aplicación web privada en un
servidor central. Los empleados entrarán mediante una dirección web desde Chrome,
Edge u otro navegador autorizado. De este modo, cada computadora podrá usar los
mismos datos sin instalar el sistema ni conservar una copia separada de la base
de datos.

Durante el desarrollo podremos ejecutarla localmente para probarla. Esa forma de
prueba no cambia la arquitectura ni impide publicarla posteriormente. Antes de
crear el proyecto se revisará el repositorio existente para decidir qué partes
pueden aprovecharse y evitar duplicar trabajo.

El lector QR USB funcionará como un teclado: escribirá el identificador en la
pantalla de escaneo. Los QR se generarán desde la aplicación y primero se
imprimirán con el cuadro normal de impresión del navegador, sin depender de una
marca de impresora.

## Reglas de datos acordadas

Los estatus visibles son `LISTO PARA ENVIAR`, `ENVIADO`, `AUTORIZADO`, `RECHAZADO` y
`REINGRESADO`. No se agregará otro estatus sin autorización.

El estatus actual se conservará en el documento para consultas rápidas y cada
cambio se registrará también como un movimiento inmutable, con fecha y hora. Un
rechazo podrá incluir motivo y observaciones opcionales.

## Estado del desarrollo

El prototipo Django fue sustituido por la base de la aplicación Next.js y las dos
variables públicas de Supabase ya pueden configurarse en Vercel. El esquema SQL
inicial está preparado para crear los catálogos, expedientes, documentos e
historial inmutable en Supabase.

El panel del administrador compara el tamaño real de la base de datos con la
capacidad configurada en `NEXT_PUBLIC_DATABASE_STORAGE_LIMIT_MB` (500 MB si no
se define). Este valor debe actualizarse en Vercel cuando cambie el plan o la
capacidad contratada de Supabase para que el porcentaje y las alertas sean
correctos.

### Configurar el límite en Vercel

No se debe crear un entorno nuevo con ese nombre. En **Project Settings →
Environments**, hay que cerrar la ventana **Create Pre-production Environment**,
abrir las variables del entorno **Production** y agregar una variable con:

- **Name:** `NEXT_PUBLIC_DATABASE_STORAGE_LIMIT_MB`
- **Value:** la capacidad en MB, por ejemplo `500`

Después se debe guardar y volver a desplegar producción. Si la capacidad es de
500 MB, no es obligatorio agregar la variable porque ese ya es el valor
predeterminado de la aplicación.
