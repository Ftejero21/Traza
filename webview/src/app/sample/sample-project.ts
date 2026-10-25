import { CodeRef, FlowDiagram } from '../workspace-code/ai/nexo-ia.types';

/**
 * Proyecto de ejemplo (login de FreeSocial) con archivos virtuales: alineado con los logs de
 * `sample-logs.ts`. Lo usan el modo navegador y el comando «Nexo: Abrir flujo de ejemplo».
 */

const LOGIN_TS = `import { Component } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

@Component({ selector: 'app-login', templateUrl: './login.component.html', styleUrls: ['./login.component.css'] })
export class LoginComponent {
  email = '';
  password = '';
  errorMessage = '';
  loading = false;

  constructor(private auth: AuthService, private router: Router) {}

  login(): void {
    if (!this.email || !this.password) return;
    this.loading = true;
    this.errorMessage = '';
    this.auth.login(this.email, this.password).subscribe({
      next: (response) => {
        localStorage.setItem('token', response.token);
        this.loading = false;
        this.router.navigate(['/inicio']);
      },
      error: () => {
        this.loading = false;
        this.errorMessage = 'Usuario o contraseña incorrectos';
      },
    });
  }
}
`;

const LOGIN_HTML = `<div class="login-card">
  <h1 class="login-title">Iniciar sesión</h1>
  <form class="login-form" (ngSubmit)="login()">
    <input class="login-input" type="email" name="email" placeholder="Email" [(ngModel)]="email" required>
    <input class="login-input" type="password" name="password" placeholder="Contraseña" [(ngModel)]="password" required>
    <p class="login-error" *ngIf="errorMessage">{{ errorMessage }}</p>
    <button class="login-btn" type="submit" [disabled]="loading">Entrar</button>
  </form>
</div>
`;

const LOGIN_CSS = `.login-card {
  max-width: 360px;
  margin: 48px auto;
  padding: 28px 24px;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.12);
  font-family: system-ui, sans-serif;
}

.login-title {
  margin: 0 0 18px;
  font-size: 22px;
  color: #111827;
}

.login-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.login-input {
  padding: 10px 12px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
}

.login-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #fef2f2;
  color: #b91c1c;
  font-size: 13px;
}

.login-btn {
  padding: 10px 12px;
  border: 0;
  border-radius: 8px;
  background: #6366f1;
  color: #ffffff;
  font-weight: 600;
  cursor: pointer;
}

.login-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
`;

const AUTH_TS = `import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface LoginResponse {
  token: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly baseUrl = 'http://localhost:8080/api/usuarios';

  constructor(private http: HttpClient) {}

  login(email: string, password: string): Observable<LoginResponse> {
    return this.http.post<LoginResponse>(\`\${this.baseUrl}/login\`, { email, password });
  }
}
`;

const CONTROLLER_JAVA = `package com.FreeSocial.com.Controller.UsuarioController;

import com.FreeSocial.com.DTO.LoginDTO;
import com.FreeSocial.com.DTO.LoginResponse;
import com.FreeSocial.com.Model.Usuario;
import com.FreeSocial.com.Security.JwtUtil;
import com.FreeSocial.com.Service.UsuarioService.UsuarioService;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/usuarios")
public class UsuarioController {

    private final UsuarioService usuarioService;
    private final JwtUtil jwtUtil;

    public UsuarioController(UsuarioService usuarioService, JwtUtil jwtUtil) {
        this.usuarioService = usuarioService;
        this.jwtUtil = jwtUtil;
    }

    @PostMapping("/login")
    public ResponseEntity<LoginResponse> loginUser(@RequestBody LoginDTO dto) {
        Usuario usuario = usuarioService.authenticate(dto.getEmail(), dto.getPassword());
        String token = jwtUtil.generateToken(usuario.getEmail());
        return ResponseEntity.ok(new LoginResponse(token));
    }
}
`;

const SERVICE_JAVA = `package com.FreeSocial.com.Service.UsuarioService;

import com.FreeSocial.com.Exception.FreeSocialException;
import com.FreeSocial.com.Model.Usuario;
import com.FreeSocial.com.Repository.UsuarioRepository;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;

@Service
public class UsuarioServiceImpl implements UsuarioService {

    private final UsuarioRepository usuarioRepository;
    private final PasswordEncoder passwordEncoder;

    public UsuarioServiceImpl(UsuarioRepository usuarioRepository, PasswordEncoder passwordEncoder) {
        this.usuarioRepository = usuarioRepository;
        this.passwordEncoder = passwordEncoder;
    }

    @Override
    public Usuario authenticate(String email, String password) {
        Usuario usuario = usuarioRepository.findByEmail(email)
                .orElseThrow(() -> new FreeSocialException("error.usuarioNoEncontrado"));
        if (!passwordEncoder.matches(password, usuario.getPassword())) {
            throw new FreeSocialException("error.login");
        }
        return usuario;
    }
}
`;

const REPOSITORY_JAVA = `package com.FreeSocial.com.Repository;

import com.FreeSocial.com.Model.Usuario;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
public interface UsuarioRepository extends JpaRepository<Usuario, Long> {

    Optional<Usuario> findByEmail(String email);
}
`;

export const P = {
  loginTs: 'frontend/src/app/login/login.component.ts',
  loginHtml: 'frontend/src/app/login/login.component.html',
  loginCss: 'frontend/src/app/login/login.component.css',
  auth: 'frontend/src/app/services/auth.service.ts',
  controller: 'backend/src/main/java/com/FreeSocial/com/Controller/UsuarioController/UsuarioController.java',
  service: 'backend/src/main/java/com/FreeSocial/com/Service/UsuarioService/UsuarioServiceImpl.java',
  repository: 'backend/src/main/java/com/FreeSocial/com/Repository/UsuarioRepository.java',
} as const;

/** Archivos virtuales del ejemplo (ruta POSIX → contenido). Montaje único `''`. */
export const SAMPLE_FILES: Record<string, string> = {
  [P.loginTs]: LOGIN_TS,
  [P.loginHtml]: LOGIN_HTML,
  [P.loginCss]: LOGIN_CSS,
  [P.auth]: AUTH_TS,
  [P.controller]: CONTROLLER_JAVA,
  [P.service]: SERVICE_JAVA,
  [P.repository]: REPOSITORY_JAVA,
};

/** Línea 1-based de la primera línea cuyo `trim()` contiene `anchor`. Falla si no existe (garantiza las anclas). */
export function lineOf(path: string, anchor: string): number {
  const content = SAMPLE_FILES[path];
  if (content === undefined) throw new Error(`[Nexo] Archivo de ejemplo inexistente: ${path}`);
  const index = content.split('\n').findIndex((line) => line.trim().includes(anchor));
  if (index < 0) throw new Error(`[Nexo] Ancla de ejemplo no encontrada en ${path}: ${anchor}`);
  return index + 1;
}

/** Referencia del ejemplo: la línea y el ancla salen del contenido real del archivo virtual. */
function ref(path: string, anchor: string, className: string, functionName: string): CodeRef {
  const line = lineOf(path, anchor);
  const text = SAMPLE_FILES[path].split('\n')[line - 1].trim();
  return { mountId: '', file: path, line, anchor: text, className, functionName };
}

export const SAMPLE_FLOW: FlowDiagram = {
  id: 'sample-login',
  title: 'Login con email y contraseña',
  question: '¿Cómo funciona el login con email y contraseña?',
  summary: 'El formulario de login llama a AuthService, que envía las credenciales al backend. UsuarioController delega en UsuarioServiceImpl, que busca el usuario por email y compara la contraseña antes de devolver el token.',
  errorSummary: 'Si falta el email o la contraseña, el formulario no envía nada. Si el email no existe responde 404 y si la contraseña no coincide lanza FreeSocialException (401).',
  lanes: [
    { id: 'login', name: 'LoginComponent', short: 'Login', sub: 'Angular', kind: 'component' },
    { id: 'auth', name: 'AuthService', short: 'AuthService', sub: 'Angular', kind: 'service' },
    { id: 'controller', name: 'UsuarioController', short: 'Controller', sub: 'Spring Boot', kind: 'api' },
    { id: 'usuarioService', name: 'UsuarioServiceImpl', short: 'UsuarioSvc', sub: 'Spring Boot', kind: 'service' },
    { id: 'db', name: 'PostgreSQL', short: 'BD', sub: 'PostgreSQL', kind: 'db' },
  ],
  steps: [
    {
      id: 's1', from: 'login', to: 'login', label: '(ngSubmit)="login()"', kind: 'code',
      title: 'El usuario envía el formulario',
      explanation: 'Al pulsar «Entrar» se ejecuta login(). Si el email o la contraseña están vacíos, el método termina sin hacer nada.',
      ref: ref(P.loginTs, 'if (!this.email || !this.password) return;', 'LoginComponent', 'login'),
      snippet: null,
    },
    {
      id: 's2', from: 'login', to: 'auth', label: 'auth.login(email, password)', kind: 'code',
      title: 'El componente llama a AuthService',
      explanation: 'LoginComponent marca loading y delega en AuthService.login() con las credenciales del formulario.',
      ref: ref(P.loginTs, 'this.auth.login(', 'LoginComponent', 'login'),
      snippet: null,
    },
    {
      id: 's3', from: 'auth', to: 'controller', label: 'POST /api/usuarios/login', kind: 'http',
      title: 'Petición HTTP al backend',
      explanation: 'AuthService envía un POST con el email y la contraseña al endpoint de login de Spring Boot.',
      ref: ref(P.auth, 'return this.http.post', 'AuthService', 'login'),
      snippet: null,
      generatedCode: {
        title: 'POST /api/usuarios/login',
        language: 'http',
        code: 'POST /api/usuarios/login\nContent-Type: application/json\n\n{ "email": "ana@freesocial.com", "password": "***" }',
        highlightIndex: 0,
      },
    },
    {
      id: 's4', from: 'controller', to: 'usuarioService', label: 'authenticate(email, password)', kind: 'code',
      title: 'El controlador delega la autenticación',
      explanation: 'UsuarioController.loginUser() recibe el LoginDTO y llama a UsuarioServiceImpl.authenticate().',
      ref: ref(P.controller, 'usuarioService.authenticate(', 'UsuarioController', 'loginUser'),
      snippet: null,
    },
    {
      id: 's5', from: 'usuarioService', to: 'db', label: 'findByEmail(email)', kind: 'sql',
      title: 'Búsqueda del usuario por email',
      explanation: 'El servicio consulta UsuarioRepository.findByEmail(). Si no hay ningún usuario con ese email, la autenticación termina con error.',
      ref: ref(P.repository, 'findByEmail(String email);', 'UsuarioRepository', 'findByEmail'),
      snippet: null,
      generatedCode: { title: 'SQL', language: 'sql', code: 'SELECT * FROM usuario WHERE email = ?', highlightIndex: 0 },
    },
    {
      id: 's6', from: 'usuarioService', to: 'usuarioService', label: 'passwordEncoder.matches()', kind: 'code',
      title: 'Comprobación de la contraseña',
      explanation: 'passwordEncoder.matches() compara la contraseña con el hash guardado. Si no coincide, lanza FreeSocialException("error.login").',
      ref: ref(P.service, 'throw new FreeSocialException("error.login");', 'UsuarioServiceImpl', 'authenticate'),
      snippet: null,
    },
    {
      id: 's7', from: 'controller', to: 'login', label: '200 { token }', kind: 'code',
      title: 'Respuesta con el token',
      explanation: 'Con las credenciales correctas, el controlador genera el JWT y responde 200 con el token, que el componente guarda antes de navegar.',
      ref: ref(P.controller, 'return ResponseEntity.ok(', 'UsuarioController', 'loginUser'),
      snippet: null,
    },
  ],
  errorExits: [
    { stepId: 's1', condition: 'Email o contraseña vacíos' },
    { stepId: 's5', httpStatus: 404, condition: 'No existe usuario con ese email' },
    { stepId: 's6', httpStatus: 401, condition: 'La contraseña no coincide' },
  ],
  inputExample: { email: 'ana@freesocial.com', password: 'Secreta123' },
  simulationPresets: [
    { id: 'ok', label: 'Credenciales válidas', input: { email: 'ana@freesocial.com', password: 'Secreta123' }, expected: { kind: 'ok', failStepId: null, httpStatus: 200 } },
    { id: 'bad-pass', label: 'Contraseña incorrecta', input: { email: 'ana@freesocial.com', password: 'otraClave' }, expected: { kind: 'error', failStepId: 's6', httpStatus: 401 } },
    { id: 'no-user', label: 'Usuario inexistente', input: { email: 'nadie@freesocial.com', password: 'Secreta123' }, expected: { kind: 'error', failStepId: 's5', httpStatus: 404 } },
    { id: 'empty', label: 'Email vacío', input: { email: '', password: 'Secreta123' }, expected: { kind: 'stop', failStepId: 's1' } },
  ],
  files: [
    ref(P.loginTs, 'login(): void {', 'LoginComponent', 'login'),
    ref(P.loginHtml, '(ngSubmit)="login()"', 'LoginComponent', 'login'),
    ref(P.auth, 'login(email: string, password: string)', 'AuthService', 'login'),
    ref(P.controller, 'public ResponseEntity<LoginResponse> loginUser(', 'UsuarioController', 'loginUser'),
    ref(P.service, 'public Usuario authenticate(', 'UsuarioServiceImpl', 'authenticate'),
    ref(P.repository, 'public interface UsuarioRepository', 'UsuarioRepository', 'findByEmail'),
  ],
  model: 'Ejemplo',
  generatedAt: new Date().toISOString(),
};
