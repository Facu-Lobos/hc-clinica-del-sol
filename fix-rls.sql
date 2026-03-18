-- 1. Habilitar RLS en la tabla profiles (por si estaba desactivada)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 2. Eliminar políticas anteriores que pudiesen estar causando conflicto (opcional)
DROP POLICY IF EXISTS "Usuarios pueden ver su propio perfil" ON public.profiles;
DROP POLICY IF EXISTS "Usuarios autenticados pueden ver todos los perfiles" ON public.profiles;

-- 3. Crear política para que un usuario pueda LEER su propio perfil
-- Esto arregla el error 406 al hacer login
CREATE POLICY "Usuarios pueden ver su propio perfil" 
ON public.profiles 
FOR SELECT 
USING (auth.uid() = id);

-- 4. (Opcional pero necesario para el panel de Admin) 
-- Permitir que un administrador pueda ver TODOS los perfiles
CREATE POLICY "Administradores pueden ver todos los perfiles" 
ON public.profiles 
FOR SELECT 
USING (
  EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND especialidad = 'Administrador'
  )
);
