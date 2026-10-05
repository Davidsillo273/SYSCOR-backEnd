// Configuración de Swagger (documentación interactiva de la API). Escanea
// los bloques JSDoc "@swagger" que viven arriba de cada definición de ruta
// en src/routes/** y arma con eso el documento OpenAPI que sirve
// swagger-ui-express. No requiere mantener un archivo YAML aparte: la
// documentación vive junto al código de la ruta que describe.
import swaggerJSDoc from "swagger-jsdoc";

const swaggerDefinition = {
  openapi: "3.0.0",
  info: {
    title: "SYSCOR API",
    version: "1.0.0",
    description:
      "API del sistema de gestión de restaurante SYSCOR (Taquería El Corral). " +
      "Cubre autenticación de administradores/empleados/clientes, menú, inventario, " +
      "pedidos, facturación, mesas, notificaciones y el asistente de IA. " +
      "La autenticación se hace por cookie de sesión (authCookie), no por header Bearer.",
  },
  servers: [
    {
      url: (process.env.API_URL ? "" : "") + "/api",
      description: "Servidor actual (ruta base de la API)",
    },
  ],
  components: {
    // Documentamos el esquema de autenticación como referencia informativa:
    // el sistema usa una cookie httpOnly llamada "authCookie", no un header
    // Authorization. Swagger UI no puede "probar" rutas protegidas sin que
    // el navegador ya tenga la cookie de una sesión iniciada por separado.
    securitySchemes: {
      cookieAuth: {
        type: "apiKey",
        in: "cookie",
        name: "authCookie",
        description: "Cookie de sesión (JWT) que se setea al iniciar sesión. Contiene el rol (admin/employee/customer) y, para empleados, sus permisos.",
      },
      kitchenDeviceAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Token de dispositivo de una pantalla de cocina (rol KITCHEN_DEVICE). Lo entrega el servidor por socket al emparejarla; solo abre las rutas /kitchen de pantalla.",
      },
    },
    schemas: {
      ErrorResponse: {
        type: "object",
        properties: {
          title: { type: "string", example: "Error del servidor" },
          message: { type: "string", example: "Ocurrió un problema interno. Intenta de nuevo más tarde." },
        },
      },
    },
  },
  tags: [
    { name: "Auth - Admins", description: "Login e invitación de administradores" },
    { name: "Auth - Employees", description: "Login e invitación de empleados" },
    { name: "Auth - Customers", description: "Login y registro de clientes" },
    { name: "Auth - Común", description: "Logout, sesión activa, cambio y recuperación de contraseña" },
    { name: "Usuarios - Admins", description: "Gestión de administradores" },
    { name: "Usuarios - Empleados", description: "Gestión de empleados" },
    { name: "Usuarios - Clientes", description: "Gestión de clientes" },
    { name: "Menú - Combos", description: "Combos del menú" },
    { name: "Menú - Bebidas", description: "Bebidas del menú" },
    { name: "Menú - Extras", description: "Extras/acompañamientos del menú" },
    { name: "Menú - Platillos", description: "Platillos (saucers) del menú" },
    { name: "Menú - Conjuntos de bebidas", description: "Agrupaciones de bebidas para armar combos" },
    { name: "Inventario", description: "Insumos, stock y activos fijos" },
    { name: "Pedidos", description: "Pedidos (comandas) de mesa y en línea" },
    { name: "Carritos", description: "Carritos de compra" },
    { name: "Pagos (Wompi)", description: "Integración con la pasarela de pagos Wompi" },
    { name: "Facturación", description: "Historial de facturas y analítica de ventas" },
    { name: "Mesas", description: "Estado y gestión de mesas" },
    { name: "Notificaciones", description: "Notificaciones internas del sistema" },
    { name: "Configuración", description: "Ajustes generales del sistema" },
    { name: "IA", description: "Asistencias de inteligencia artificial (sugerencia de recetas, proyección de stock)" },
    { name: "Chat", description: "Asistente conversacional de IA" },
  ],
};

const swaggerOptions = {
  swaggerDefinition,
  // Escanea todas las rutas en busca de bloques @swagger
  apis: ["./src/routes/**/*.js"],
};

export const swaggerSpec = swaggerJSDoc(swaggerOptions);

export default swaggerSpec;
